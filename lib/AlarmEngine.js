'use strict';

const EventEmitter = require('events');

/**
 * Alarm modes map 1:1 onto Homey's built-in `homealarm_state` capability.
 */
const MODES = Object.freeze(['disarmed', 'armed', 'partially_armed']);

/**
 * Phases describe what the engine is doing on top of the mode:
 *  - idle:   disarmed, nothing running
 *  - arming: exit delay countdown running, mode not yet applied
 *  - armed:  mode is armed or partially_armed, watching sensors
 *  - entry:  a delayed sensor tripped, entry delay countdown running
 *  - alarm:  the alarm is sounding
 */
const PHASES = Object.freeze(['idle', 'arming', 'armed', 'entry', 'alarm']);

const DEFAULT_CONFIG = Object.freeze({
  exitDelay: 30,        // seconds before an "armed" (away) request becomes effective
  exitDelayHome: 0,     // same for "partially armed" (home); you are not leaving, so none by default
  entryDelay: 30,       // seconds between a delayed sensor trip and the alarm
  alarmDuration: 300,   // seconds the alarm stays active, 0 = until disarmed
  preArmCheck: 'block', // 'block' | 'warn' | 'off'
  endCheckContactOnly: true, // end-of-exit-delay check ignores motion-type sensors (they hold "active" for a while)
});

/** Sensor types that keep reporting "active" for a while after the last event. */
const MOTION_LIKE = Object.freeze(['alarm_motion', 'alarm_occupancy', 'alarm_presence']);

/**
 * Pure alarm state machine. Knows nothing about Homey; the app wires it to
 * devices, flows, widgets and sensors through the events it emits:
 *
 *  'mode'            { mode, previousMode, source, user }
 *  'phase'           { phase, previousPhase }
 *  'arming'          { mode, seconds, source, user }
 *  'armBlocked'      { mode, sensors: [{ id, name }], source, user }
 *  'armWarning'      { mode, sensors, source, user }
 *  'tick'            { type: 'exit'|'entry'|'alarm', seconds }
 *  'entry'           { sensor, seconds }
 *  'alarm'           { active: true, sensor, reason }
 *  'alarmEnded'      { source, user, reason: 'disarmed'|'deactivated'|'timeout' }
 *  'countdownCancelled' { type, source }
 *  'persist'         { mode, phase, alarmReason }   (ask the host to store state)
 */
class AlarmEngine extends EventEmitter {

  /**
   * @param {object} opts
   * @param {Function} opts.setTimeout  host timer (Homey apps must use homey.setTimeout)
   * @param {Function} opts.clearTimeout
   * @param {Function} [opts.log]
   */
  constructor({ setTimeout, clearTimeout, log = () => {} }) {
    super();
    this._setTimeout = setTimeout;
    this._clearTimeout = clearTimeout;
    this._log = log;

    this.config = { ...DEFAULT_CONFIG };
    this.sensors = new Map(); // id -> { id, name, capability, modes: Set, entryDelay: bool, active: bool }

    this.mode = 'disarmed';
    this.phase = 'idle';
    this.pendingMode = null;
    this.countdown = { type: null, seconds: 0 };
    this.alarmReason = null;
    this.alarmSince = null;     // when the current alarm started sounding (ms)
    this.pendingSensor = null;  // sensor that started the entry delay
    this.lastArmBlocked = null; // { mode, sensors, at } when the last arm attempt was blocked

    this._timer = null;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setConfig(config = {}) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (config[key] === undefined || config[key] === null) continue;
      this.config[key] = config[key];
    }
    this.config.exitDelay = clampInt(this.config.exitDelay, 0, 600);
    this.config.exitDelayHome = clampInt(this.config.exitDelayHome, 0, 600);
    this.config.entryDelay = clampInt(this.config.entryDelay, 0, 600);
    this.config.alarmDuration = clampInt(this.config.alarmDuration, 0, 3600);
    if (!['block', 'warn', 'off'].includes(this.config.preArmCheck)) {
      this.config.preArmCheck = 'block';
    }
    this.config.endCheckContactOnly = this.config.endCheckContactOnly !== false;
  }

  /**
   * Replace the sensor configuration. Keeps the last known `active` flag for
   * sensors that already existed so a reload does not forget an open door.
   * @param {Array<{id:string,name:string,capability:string,modes:string[],entryDelay?:boolean}>} list
   */
  setSensors(list = []) {
    const next = new Map();
    for (const s of list) {
      if (!s || !s.id) continue;
      const prev = this.sensors.get(s.id);
      next.set(s.id, {
        id: s.id,
        deviceId: s.deviceId || null,
        name: s.name || s.id,
        capability: s.capability || 'alarm_contact',
        modes: new Set((s.modes || []).filter(m => m === 'armed' || m === 'partially_armed')),
        entryDelay: Boolean(s.entryDelay),
        enabled: s.enabled !== false,
        active: prev ? prev.active : false,
        lastActiveAt: prev ? prev.lastActiveAt || null : null,
        lastChangedAt: prev ? prev.lastChangedAt || null : null,
      });
    }
    this.sensors = next;
  }

  /**
   * Include (enabled=true) or exclude (bypass) a sensor without touching its
   * mode assignment. Excluded sensors neither block arming nor trigger.
   * Emits 'sensorEnabled' { id, name, enabled } when the flag changes.
   * @returns {boolean} true when the sensor exists
   */
  setSensorEnabled(sensorId, enabled) {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return false;
    const next = Boolean(enabled);
    if (sensor.enabled === next) return true;
    sensor.enabled = next;
    this.emit('sensorEnabled', { id: sensor.id, name: sensor.name, enabled: next });
    return true;
  }

  isSensorEnabled(sensorId) {
    const sensor = this.sensors.get(sensorId);
    return sensor ? sensor.enabled : false;
  }

  /** Sensors as plain objects, for settings persistence and pickers. */
  listSensors() {
    return [...this.sensors.values()].map(s => ({
      id: s.id,
      deviceId: s.deviceId,
      name: s.name,
      capability: s.capability,
      modes: [...s.modes],
      entryDelay: s.entryDelay,
      enabled: s.enabled,
      active: s.active,
      lastActiveAt: s.lastActiveAt || null,
      lastChangedAt: s.lastChangedAt || null,
    }));
  }

  /**
   * Restore persisted state after an app restart. Countdowns are never
   * restored: an interrupted exit delay becomes armed, an interrupted entry
   * delay becomes an alarm, because failing safe means staying armed.
   */
  restore({ mode, phase, alarmReason } = {}) {
    if (MODES.includes(mode)) this.mode = mode;
    this.alarmReason = alarmReason || null;
    if (this.mode === 'disarmed') {
      this.phase = 'idle';
    } else if (phase === 'alarm' || phase === 'entry') {
      this.phase = 'alarm';
    } else {
      this.phase = 'armed';
    }
  }

  /**
   * Call once after restore() and after the host has wired its listeners:
   * when the restored phase is 'alarm', re-announce it so sirens, lights,
   * flows and the duration timer come back as well.
   */
  resumeIfAlarm() {
    if (this.phase !== 'alarm') return false;
    if (!this.alarmSince) this.alarmSince = Date.now();
    const reason = this.alarmReason || 'restored';
    this.emit('alarm', { active: true, sensor: null, reason, restored: true });
    if (this.config.alarmDuration > 0) {
      this._startCountdown('alarm', this.config.alarmDuration, () => {
        this.alarmReason = null;
        this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
        this.emit('alarmEnded', { source: 'timer', user: null, reason: 'timeout' });
        this._persist();
      }, { silentTicks: true });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------------

  getStatus() {
    return {
      mode: this.mode,
      phase: this.phase,
      pendingMode: this.pendingMode,
      countdown: this.countdown.type ? { ...this.countdown } : null,
      alarmActive: this.phase === 'alarm',
      alarmPending: this.phase === 'entry',
      pendingSensor: this.pendingSensor,
      alarmReason: this.alarmReason,
      alarmSince: this.alarmSince,
      openSensors: this.getActiveSensors().map(s => ({ id: s.id, name: s.name })),
      lastArmBlocked: this.lastArmBlocked,
      excludedSensors: [...this.sensors.values()].filter(s => !s.enabled).map(s => ({ id: s.id, name: s.name })),
      config: { ...this.config },
    };
  }

  /** Open sensors that count: enabled and (optionally) assigned to `mode`. */
  getActiveSensors(mode = null) {
    const out = [];
    for (const s of this.sensors.values()) {
      if (!s.active || !s.enabled) continue;
      if (mode && !s.modes.has(mode)) continue;
      out.push(s);
    }
    return out;
  }

  isCountdownRunning() {
    return this.phase === 'arming' || this.phase === 'entry';
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Request a mode change. Arming goes through the pre-arm check and the exit
   * delay; disarming is immediate and also silences an alarm.
   * @param {string} mode
   * @param {object} ctx { source: 'widget'|'flow'|'device'|'panel'|'api', user?: string, immediate?: boolean }
   * @returns {{ ok: boolean, reason?: string, sensors?: Array }}
   */
  requestMode(mode, ctx = {}) {
    if (!MODES.includes(mode)) {
      return { ok: false, reason: 'invalid_mode' };
    }
    const source = ctx.source || 'api';

    if (mode === 'disarmed') {
      this.disarm(ctx);
      return { ok: true };
    }

    // Already in that mode and settled: nothing to do. Re-entering the exit
    // delay would create a blind window and duplicate triggers.
    if (mode === this.mode && this.phase === 'armed') {
      return { ok: true, unchanged: true };
    }

    // Arming while the alarm sounds or during an entry countdown ends that
    // alarm, so it is only allowed for a verified person (code entered, or a
    // linked panel that verified its own code). Code-less flows, the device
    // tile and the API are refused: otherwise they could defuse an intrusion.
    if (this.phase === 'alarm' || this.phase === 'entry') {
      if (!ctx.user) {
        return { ok: false, reason: this.phase === 'alarm' ? 'alarm_active' : 'alarm_pending' };
      }
      if (this.phase === 'alarm') {
        this._cancelTimer();
        this.alarmReason = null;
        this.pendingSensor = null;
        this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
        this.emit('alarmEnded', { source, user: ctx.user, reason: 'rearmed' });
      } else {
        const type = this.countdown.type;
        this._cancelTimer();
        this.pendingSensor = null;
        this._setPhase('armed');
        this.emit('countdownCancelled', { type, source });
      }
    }
    this.pendingMode = null;

    // Arming (or switching between armed and partially_armed).
    //
    // The open-sensor policy (block / warn / off) is applied when the mode
    // actually takes effect: immediately when there is no exit delay, or at
    // the END of the exit delay. The delay exists so you can leave through a
    // door that is open now or opens while you walk out. At the start we only
    // inform (the `arming` event carries the sensors that are open).
    const configured = mode === 'partially_armed' ? this.config.exitDelayHome : this.config.exitDelay;
    const delay = ctx.immediate ? 0 : configured;
    const checkNeeded = this.config.preArmCheck !== 'off' && !ctx.skipCheck;
    this.lastArmBlocked = null;

    if (delay <= 0) {
      if (checkNeeded) {
        const verdict = this._checkOpenSensors(mode, ctx, 'immediate');
        if (!verdict.ok) return verdict;
      }
      this._cancelTimer();
      this._applyMode(mode, ctx);
      return { ok: true };
    }

    // Start (or restart) exit delay
    this._cancelTimer();
    this.pendingMode = mode;
    this._setPhase('arming');
    const openNow = this.getActiveSensors(mode).map(s => ({ id: s.id, name: s.name }));
    this._startCountdown('exit', delay, () => {
      this.pendingMode = null;
      if (checkNeeded) {
        const verdict = this._checkOpenSensors(mode, ctx, 'end');
        if (!verdict.ok) {
          // Stay in the previous mode; tell listeners the arming was abandoned.
          this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
          this.emit('mode', { mode: this.mode, previousMode: this.mode, source, user: ctx.user || null, cancelled: true });
          return;
        }
      }
      this._applyMode(mode, ctx);
    });
    this.emit('arming', { mode, seconds: delay, source, user: ctx.user || null, openSensors: openNow });
    return { ok: true, delayed: true, seconds: delay, openSensors: openNow };
  }

  /**
   * Apply the open-sensor policy for `mode`.
   * @returns {{ ok: true } | { ok: false, reason: 'sensors_open', sensors }}
   */
  _checkOpenSensors(mode, ctx, stage) {
    // At the end of the exit delay a motion sensor you just walked past may
    // still be "active" for a while; optionally only doors and windows count.
    const contactOnly = stage === 'end' && this.config.endCheckContactOnly;
    const open = this.getActiveSensors(mode)
      .filter(s => !(contactOnly && MOTION_LIKE.includes(s.capability)))
      .map(s => ({ id: s.id, name: s.name }));
    if (open.length === 0) return { ok: true };
    const source = ctx.source || 'api';
    if (this.config.preArmCheck === 'block') {
      this._log(`Arm ${mode} blocked (${stage}) by open sensors: ${open.map(s => s.name).join(', ')}`);
      this.lastArmBlocked = { mode, sensors: open, at: Date.now() };
      this.emit('armBlocked', { mode, sensors: open, source, user: ctx.user || null, stage });
      return { ok: false, reason: 'sensors_open', sensors: open };
    }
    this.emit('armWarning', { mode, sensors: open, source, user: ctx.user || null, stage });
    return { ok: true };
  }

  disarm(ctx = {}) {
    const source = ctx.source || 'api';
    const wasAlarm = this.phase === 'alarm';
    const wasCountdown = this.isCountdownRunning();
    const countdownType = this.countdown.type;

    this._cancelTimer();
    this.pendingMode = null;
    this.pendingSensor = null;

    if (wasCountdown) {
      this.emit('countdownCancelled', { type: countdownType, source });
    }

    const previousMode = this.mode;
    this.mode = 'disarmed';
    this._setPhase('idle');

    if (wasAlarm) {
      this.alarmReason = null;
      this.emit('alarmEnded', { source, user: ctx.user || null, reason: 'disarmed', panic: Boolean(ctx.panic) });
    }

    if (previousMode !== 'disarmed') {
      this.emit('mode', { mode: 'disarmed', previousMode, source, user: ctx.user || null, panic: Boolean(ctx.panic) });
    } else if (wasCountdown) {
      // Arming was cancelled before it became effective; mode did not change
      // but listeners (widget) still want to know.
      this.emit('mode', { mode: 'disarmed', previousMode, source, user: ctx.user || null, cancelled: true });
    }
    this._persist();
  }

  /**
   * Stop a sounding alarm but stay armed.
   */
  deactivateAlarm(ctx = {}) {
    if (this.phase !== 'alarm') return false;
    this._cancelTimer();
    this.alarmReason = null;
    this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
    this.emit('alarmEnded', { source: ctx.source || 'api', user: ctx.user || null, reason: 'deactivated' });
    this._persist();
    return true;
  }

  /**
   * Cancel a running exit or entry countdown without changing the mode.
   * Cancelling an entry countdown means "I know it's me", so the system stays armed.
   */
  cancelCountdown(ctx = {}) {
    if (!this.isCountdownRunning()) return false;
    const type = this.countdown.type;
    this._cancelTimer();
    this.pendingMode = null;
    this.pendingSensor = null;
    this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
    this.emit('countdownCancelled', { type, source: ctx.source || 'api' });
    return true;
  }

  /**
   * Force the alarm, e.g. from a panic button flow card.
   */
  triggerAlarm(reason = 'manual', sensor = null) {
    this._startAlarm({ sensor, reason });
  }

  // ---------------------------------------------------------------------------
  // Sensor input
  // ---------------------------------------------------------------------------

  /**
   * Feed a sensor capability value. `value` true means "tripped" (door open,
   * motion seen, tamper). Call this for every change, including false.
   * `seed` marks the value learned at (re)subscription, which is never a trip;
   * `at` is Homey's own timestamp of that value (capability lastUpdated), so
   * "open since" and "closed since" survive a restart of the app.
   */
  onSensorValue(sensorId, value, { seed = false, at = null } = {}) {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return;
    const tripped = Boolean(value);
    const changed = sensor.active !== tripped;
    sensor.active = tripped;
    if (seed) {
      if (at) {
        sensor.lastChangedAt = at;
        if (tripped) sensor.lastActiveAt = at;
      }
    } else if (changed) {
      sensor.lastChangedAt = Date.now();
      if (tripped) sensor.lastActiveAt = sensor.lastChangedAt;
    }
    if (changed) this.emit('sensor', { id: sensor.id, name: sensor.name, active: tripped });

    if (!tripped) return;
    if (seed) return;                            // current value learned at (re)subscription: no trip
    if (!sensor.enabled) return;                 // excluded / bypassed
    if (this.phase !== 'armed') return;          // arming, entry, alarm, idle: ignore
    if (!sensor.modes.has(this.mode)) return;    // sensor not part of current mode

    if (sensor.entryDelay && this.config.entryDelay > 0) {
      this.pendingSensor = { id: sensor.id, name: sensor.name };
      this._setPhase('entry');
      this._startCountdown('entry', this.config.entryDelay, () => {
        this._startAlarm({ sensor: { id: sensor.id, name: sensor.name }, reason: 'sensor' });
      });
      this.emit('entry', { sensor: { id: sensor.id, name: sensor.name }, seconds: this.config.entryDelay });
      return;
    }

    this._startAlarm({ sensor: { id: sensor.id, name: sensor.name }, reason: 'sensor' });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _applyMode(mode, ctx = {}) {
    const previousMode = this.mode;
    this.mode = mode;
    this.lastArmBlocked = null;
    this._setPhase('armed');
    this.emit('mode', { mode, previousMode, source: ctx.source || 'api', user: ctx.user || null });
    this._persist();
  }

  _startAlarm({ sensor, reason }) {
    if (this.phase === 'alarm') return; // already sounding, keep first reason
    this._cancelTimer();
    this.pendingSensor = null;
    this.pendingMode = null;
    this.alarmReason = sensor ? sensor.name : reason;
    this.alarmSince = Date.now();
    this._setPhase('alarm');
    this.emit('alarm', { active: true, sensor: sensor || null, reason });
    this._persist();

    if (this.config.alarmDuration > 0) {
      this._startCountdown('alarm', this.config.alarmDuration, () => {
        this.alarmReason = null;
        this._setPhase(this.mode === 'disarmed' ? 'idle' : 'armed');
        this.emit('alarmEnded', { source: 'timer', user: null, reason: 'timeout' });
        this._persist();
      }, { silentTicks: true });
    }
  }

  _startCountdown(type, seconds, onDone, { silentTicks = false } = {}) {
    this._cancelTimer();
    this.countdown = { type, seconds, total: seconds };
    const tick = () => {
      if (this.countdown.seconds <= 0) {
        this.countdown = { type: null, seconds: 0 };
        this._timer = null;
        onDone();
        return;
      }
      if (!silentTicks) this.emit('tick', { type, seconds: this.countdown.seconds });
      this._timer = this._setTimeout(() => {
        this.countdown.seconds -= 1;
        tick();
      }, 1000);
    };
    tick();
  }

  _cancelTimer() {
    if (this._timer) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
    this.countdown = { type: null, seconds: 0 };
  }

  _setPhase(phase) {
    if (!PHASES.includes(phase) || phase === this.phase) return;
    const previousPhase = this.phase;
    this.phase = phase;
    this.emit('phase', { phase, previousPhase });
  }

  _persist() {
    this.emit('persist', { mode: this.mode, phase: this.phase, alarmReason: this.alarmReason });
  }

  destroy() {
    this._cancelTimer();
    this.removeAllListeners();
  }

}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

AlarmEngine.MODES = MODES;
AlarmEngine.MOTION_LIKE = MOTION_LIKE;
AlarmEngine.PHASES = PHASES;
AlarmEngine.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = AlarmEngine;
