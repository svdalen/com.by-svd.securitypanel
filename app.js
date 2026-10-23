'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const AlarmEngine = require('./lib/AlarmEngine');
const PinStore = require('./lib/PinStore');
const SensorMonitor = require('./lib/SensorMonitor');
const Indicators = require('./lib/Indicators');
const { mapKeypadKey, resolveEnter } = require('./lib/keypadKeys');
const { feedbackIndicator } = require('./lib/ringIndicators');

const SETTINGS = Object.freeze({
  config: 'config',                 // { exitDelay, entryDelay, alarmDuration, preArmCheck }
  sensors: 'sensors',               // per-sensor overrides: [{ id, modes, entryDelay, enabled }]
  sensorDefaults: 'sensorDefaults', // { autoInclude, motionInPartial }
  panels: 'panels',                 // [deviceId] linked alarm panels (e.g. Ring)
  state: 'state',                   // { mode, phase, alarmReason }
  keypad: 'keypad',                 // { pinForArm }
  panic: 'panic',                   // { suffix }
  timeline: 'timeline',             // { pending, alarm, mode }
  sirens: 'sirens',                 // [deviceId]
  leds: 'leds',                     // see Indicators.DEFAULT_LED
  security: 'security',             // { tileProtection: 'none'|'disarm'|'all', flowDisarm: bool }
  usersPending: 'usersPending',     // written by the settings page, consumed by _processPendingUsers
});

const MOTION_LIKE = new Set(['alarm_motion', 'alarm_occupancy', 'alarm_presence']);
const EVENT_LOG_SIZE = 200;

module.exports = class SecurityPanelApp extends Homey.App {

  async onInit() {
    this.log('Security Panel starting');
    this._events = []; // recent sensor and system changes for the timeline widget (memory only)
    this._eventsVersion = 0;
    this._sensorById = new Map(); // effective sensor rows by id (zone, plain device name)
    this._registerWidgets();

    this.engine = new AlarmEngine({
      setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
      clearTimeout: id => this.homey.clearTimeout(id),
      log: (...args) => this.log('[engine]', ...args),
    });
    this.pins = new PinStore({
      settings: this.homey.settings,
      log: (...args) => this.log('[pins]', ...args),
    });

    this.engine.setConfig(this.homey.settings.get(SETTINGS.config) || {});
    this.engine.restore(this.homey.settings.get(SETTINGS.state) || {});

    this.keypads = new Set(); // Ring Keypad devices paired to this app

    this._registerEngineListeners();
    this._registerFlowCards();

    this.homey.settings.on('set', key => this._onSettingChanged(key));
    // A user save that was interrupted by a restart must not linger unhashed.
    this._processPendingUsers().catch(err => this.error(err));

    // Web API connection for sensors, linked panels and indicators. Errors
    // here must not stop the app: the panel device and widget still work.
    // Once that has settled (sirens/LEDs available or not), re-announce an
    // alarm that was sounding or pending when the app went down.
    this._startMonitor()
      .catch(err => this.error('Monitor failed to start:', err))
      .finally(() => {
        if (this.engine.resumeIfAlarm()) this.log('Alarm resumed after restart');
      });

    this.log(`Security Panel ready, mode=${this.engine.mode} phase=${this.engine.phase}`);
  }

  async onUninit() {
    if (this.monitor) await this.monitor.stop().catch(() => {});
    if (this.indicators) this.indicators.destroy();
    this.engine.destroy();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  _onSettingChanged(key) {
    switch (key) {
      case SETTINGS.config:
        this.engine.setConfig(this.homey.settings.get(SETTINGS.config) || {});
        this._broadcast();
        break;
      case SETTINGS.sensors:
      case SETTINGS.sensorDefaults:
        this._rebuildSensors().catch(err => this.error(err));
        break;
      case SETTINGS.panels:
        if (this.monitor) this.monitor.watchPanels(this.homey.settings.get(SETTINGS.panels) || []).catch(err => this.error(err));
        break;
      case SETTINGS.sirens:
      case SETTINGS.leds:
        this._configureIndicators().catch(err => this.error(err));
        break;
      case SETTINGS.usersPending:
        // The settings page (owner/manager only) saves users through a
        // setting rather than the app API, so user management is not
        // reachable by every logged-in Homey user. Hash and store here.
        this._processPendingUsers().catch(err => this.error(err));
        break;
      default:
        break;
    }
  }

  async _processPendingUsers() {
    const pending = this.homey.settings.get(SETTINGS.usersPending);
    if (!Array.isArray(pending)) return;
    this.homey.settings.unset(SETTINGS.usersPending);
    try {
      const users = await this.pins.replace(pending, { panicSuffix: this.getPanicSuffix() });
      this.homey.api.realtime('usersResult', { ok: true, users }).catch(() => {});
      this._broadcast();
    } catch (err) {
      this.homey.api.realtime('usersResult', { ok: false, error: err.message }).catch(() => {});
    }
  }

  getKeypadSettings() {
    return { pinForArm: true, ...(this.homey.settings.get(SETTINGS.keypad) || {}) };
  }

  getPanicSuffix() {
    const panic = this.homey.settings.get(SETTINGS.panic) || {};
    const suffix = String(panic.suffix || '');
    return /^\d{1,2}$/.test(suffix) ? suffix : '';
  }

  getTimelineSettings() {
    return { pending: true, alarm: true, mode: false, ...(this.homey.settings.get(SETTINGS.timeline) || {}) };
  }

  /**
   * What the panel's device tile / popup may do without a PIN:
   *  'none'   anything (like Heimdall's switch)
   *  'disarm' arm only; disarming needs the keypad (default)
   *  'all'    nothing; the tile is read-only
   * The panel uses the `sensor` device class (as Heimdall does) so a tap on
   * its dashboard tile only opens it; the alarm class made a tap arm it.
   */
  getTileProtection() {
    const sec = this.homey.settings.get(SETTINGS.security) || {};
    return ['none', 'disarm', 'all'].includes(sec.tileProtection) ? sec.tileProtection : 'disarm';
  }

  /**
   * Whether PIN-less flow cards and API calls may weaken the alarm: disarm,
   * silence, cancel an entry countdown or exclude a sensor. Guests can start
   * flows manually, so this closes that path when false; cards that take a
   * code always work.
   */
  flowsMayDisarm() {
    const sec = this.homey.settings.get(SETTINGS.security) || {};
    return sec.flowDisarm !== false;
  }

  /** Guard for PIN-less mode changes: only disarming is protected. */
  assertFlowMayDisarm(mode) {
    if (mode === 'disarmed') this.assertFlowMayWeaken();
  }

  /** Guard for PIN-less actions that weaken the alarm. */
  assertFlowMayWeaken() {
    if (!this.flowsMayDisarm()) {
      throw new Error(this.homey.__('errors.flow_disarm_protected'));
    }
  }

  getSensorDefaults() {
    return { autoInclude: true, motionInPartial: false, ...(this.homey.settings.get(SETTINGS.sensorDefaults) || {}) };
  }

  // ---------------------------------------------------------------------------
  // Web API monitor (sensors + linked panels + indicators)
  // ---------------------------------------------------------------------------

  async _startMonitor() {
    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    this.monitor = new SensorMonitor({
      api: this.api,
      ownAppId: this.homey.manifest.id,
      onSensor: (id, value, opts) => this.engine.onSensorValue(id, value, opts),
      onPanelMode: (deviceId, mode, name) => this._onLinkedPanelMode(deviceId, mode, name),
      onDevicesChanged: () => this._rebuildSensorsDebounced(),
      log: (...args) => this.log('[monitor]', ...args),
      error: (...args) => this.error('[monitor]', ...args),
    });
    await this.monitor.start();

    this.indicators = new Indicators({
      bridge: this.monitor,
      setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
      clearTimeout: id => this.homey.clearTimeout(id),
      log: (...args) => this.log('[indicators]', ...args),
      error: (...args) => this.error('[indicators]', ...args),
    });

    await this._rebuildSensors();
    await this.monitor.watchPanels(this.homey.settings.get(SETTINGS.panels) || []);
    await this._configureIndicators();
    this.log('Monitor started');
  }

  /**
   * Every sensor on Homey takes part by default (unless auto-include is off);
   * the `sensors` setting holds per-sensor overrides for mode, entry delay
   * and include/exclude. New sensors are picked up automatically.
   */
  async _rebuildSensors() {
    if (!this.monitor) return;
    const discovered = await this.monitor.listAvailableSensors();
    const overrides = new Map((this.homey.settings.get(SETTINGS.sensors) || []).map(s => [s.id, s]));
    const defaults = this.getSensorDefaults();

    const merged = [];
    for (const d of discovered) {
      const o = overrides.get(d.id);
      if (!o && !(defaults.autoInclude && !d.safety)) continue; // safety sensors only by explicit choice
      merged.push({
        id: d.id,
        deviceId: d.deviceId,
        capability: d.capability,
        name: d.zone ? `${d.name} (${d.zone})` : d.name, // engine name, used in flows and the timeline
        deviceName: d.name,
        zone: d.zone || null,
        modes: o ? (Array.isArray(o.modes) ? o.modes : []) : this._defaultModes(d.capability, defaults),
        entryDelay: o ? Boolean(o.entryDelay) : false,
        enabled: o ? o.enabled !== false : true,
        source: o ? 'override' : 'default',
      });
    }

    this._sensorTable = merged;
    this._sensorById = new Map(merged.map(m => [m.id, m]));
    this.engine.setSensors(merged);
    await this.monitor.watchSensors(merged);
    this.log(`Sensors: ${merged.length} active (${discovered.length} discovered)`);
    this._broadcast();
  }

  _rebuildSensorsDebounced() {
    if (this._rebuildTimer) this.homey.clearTimeout(this._rebuildTimer);
    this._rebuildTimer = this.homey.setTimeout(() => {
      this._rebuildTimer = null;
      this._rebuildSensors().catch(err => this.error(err));
    }, 2000);
  }

  _defaultModes(capability, defaults) {
    if (MOTION_LIKE.has(capability)) {
      return defaults.motionInPartial ? ['armed', 'partially_armed'] : ['armed'];
    }
    return ['armed', 'partially_armed'];
  }

  /** Sensor table for the settings page: effective config + live value. */
  async getSensorTable() {
    if (!this.monitor) throw new Error('Monitor not connected');
    const discovered = await this.monitor.listAvailableSensors();
    const effective = new Map((this._sensorTable || []).map(s => [s.id, s]));
    const engineSensors = new Map(this.engine.listSensors().map(s => [s.id, s]));
    return discovered.map(d => {
      const e = effective.get(d.id);
      const live = engineSensors.get(d.id);
      return {
        id: d.id,
        deviceId: d.deviceId,
        capability: d.capability,
        name: d.name,
        zone: d.zone,
        value: d.value,
        safety: Boolean(d.safety),
        included: Boolean(e),
        modes: e ? e.modes : [],
        entryDelay: e ? e.entryDelay : false,
        enabled: e ? (live ? live.enabled : e.enabled) : false,
        source: e ? e.source : 'none',
      };
    });
  }

  async _configureIndicators() {
    if (!this.indicators) return;
    await this.indicators.configure({
      sirens: this.homey.settings.get(SETTINGS.sirens) || [],
      leds: this.homey.settings.get(SETTINGS.leds) || {},
    });
    await this.indicators.applyLed(this.engine.getStatus());
  }

  /**
   * A linked panel (e.g. Ring basestation, armed from its own keypad) changed
   * mode. Ring has already validated its PIN and run its own exit delay, so
   * follow immediately.
   */
  _onLinkedPanelMode(deviceId, mode, name) {
    if (mode === this.engine.mode && !this.engine.isCountdownRunning()) return;
    this.log(`Linked panel ${name} changed to ${mode}`);
    this.engine.requestMode(mode, { source: 'panel', user: name, immediate: true, skipCheck: true });
  }

  // ---------------------------------------------------------------------------
  // Engine -> Homey wiring
  // ---------------------------------------------------------------------------

  _registerEngineListeners() {
    const e = this.engine;

    e.on('persist', state => this.homey.settings.set(SETTINGS.state, state));

    e.on('mode', async ({ mode, previousMode, source, user, cancelled }) => {
      this._updatePanelDevices({ homealarm_state: mode });
      if (!cancelled) {
        this._logEvent({ type: 'mode', mode });
        const tokens = { user: user || '', source };
        this._trigger('mode_changed', { mode, previous_mode: previousMode, ...tokens });
        this._trigger(`system_${mode}`, tokens);
        this._triggerDevice(`panel_${mode}`, tokens);
        this._timeline('mode', this.homey.__(`timeline.mode_${mode}`, { user: user || source }));
      }
      if (this.monitor && source !== 'panel') this.monitor.pushMode(mode).catch(err => this.error(err));
      this._led();
      this._keypads(k => k.showMode(mode));
      this._broadcast();
    });

    e.on('phase', ({ phase }) => {
      this._updatePanelDevices({ countdown_seconds: e.countdown.seconds || 0, alarm_pending: phase === 'entry' });
      this._led();
      this._broadcast();
    });

    e.on('arming', ({ mode, seconds, source, user, openSensors }) => {
      const open = (openSensors || []).map(s => s.name).join(', ');
      this._trigger('arming_started', { mode, seconds, source, user: user || '', open_sensors: open });
      this._triggerDevice('panel_exit_delay', { mode, seconds, open_sensors: open });
      this._keypads(k => k.showDelay('exit', seconds, mode));
      this._broadcast();
    });

    e.on('armBlocked', ({ mode, sensors, source, user, stage }) => {
      const names = sensors.map(s => s.name).join(', ');
      this._trigger('arming_blocked', { mode, sensors: names, source, user: user || '', stage: stage || 'immediate' });
      if (stage === 'end') {
        // Nobody is at the keypad any more: make sure it reaches the timeline.
        this._timeline('mode', this.homey.__('timeline.arm_blocked', { sensors: names }));
        this._keypads(async k => { await k.send(feedbackIndicator(false)); await k.showMode(this.engine.mode); });
      }
      this._broadcast();
    });

    e.on('armWarning', ({ mode, sensors, stage }) => {
      this._trigger('arming_warning', { mode, sensors: sensors.map(s => s.name).join(', '), stage: stage || 'immediate' });
      this._keypads(k => k.showBypass());
    });

    e.on('tick', ({ type, seconds }) => {
      this._trigger('countdown_tick', { type, seconds });
      this._updatePanelDevices({ countdown_seconds: seconds });
      this._broadcast();
    });

    e.on('entry', ({ sensor, seconds }) => {
      this._logEvent({ type: 'entry', name: sensor ? sensor.name : null });
      this._trigger('entry_delay_started', { sensor: sensor.name, seconds });
      this._triggerDevice('panel_alarm_triggered', { sensor: sensor.name, seconds });
      this._timeline('pending', this.homey.__('timeline.pending', { sensor: sensor.name, seconds }));
      this._keypads(k => k.showDelay('entry', seconds));
      this._broadcast();
    });

    e.on('alarm', ({ sensor, reason }) => {
      this._logEvent({ type: 'alarm', name: sensor ? sensor.name : null, reason: reason || null });
      this._updatePanelDevices({ alarm_sounding: true, alarm_pending: false, countdown_seconds: 0 });
      const tokens = { sensor: sensor ? sensor.name : '', reason };
      this._trigger('alarm_triggered', tokens);
      this._triggerDevice('panel_alarm_sounding', tokens);
      this._timeline('alarm', this.homey.__('timeline.alarm', { sensor: sensor ? sensor.name : reason }));
      if (this.indicators) this.indicators.setSirens(true).catch(err => this.error(err));
      this._keypads(k => k.showAlarm(true));
      this._broadcast();
    });

    e.on('alarmEnded', ({ source, user, reason }) => {
      this._logEvent({ type: 'alarm_ended' });
      this._updatePanelDevices({ alarm_sounding: false });
      this._trigger('alarm_ended', { source, user: user || '', reason });
      this._triggerDevice('panel_alarm_stopped', { reason, user: user || '' });
      if (this.indicators) this.indicators.setSirens(false).catch(err => this.error(err));
      this._keypads(async k => { await k.showAlarm(false); await k.showMode(this.engine.mode); });
      this._broadcast();
    });

    e.on('countdownCancelled', ({ type, source }) => {
      this._trigger('countdown_cancelled', { type, source });
      this._updatePanelDevices({ countdown_seconds: 0 });
      this._keypads(k => k.showMode(this.engine.mode));
      this._broadcast();
    });

    e.on('sensor', ({ id, name, active }) => {
      const s = this.engine.sensors.get(id);
      const row = s ? this._sensorRow(s) : { id, deviceId: null, name, capability: 'alarm_contact', zone: null };
      this._logEvent({ type: 'sensor', id, deviceId: row.deviceId, name: row.name, active, capability: row.capability, zone: row.zone });
      this._broadcast();
    });

    e.on('sensorEnabled', ({ id, name, enabled }) => {
      this._persistSensorEnabled(id, enabled);
      this._trigger('sensor_excluded_changed', { sensor: name, excluded: !enabled });
      this._broadcast();
    });
  }

  _led() {
    if (!this.indicators) return;
    this.indicators.applyLed(this.engine.getStatus()).catch(err => this.error('[led]', err.message));
  }

  // ---------------------------------------------------------------------------
  // Physical keypads paired to this app (Ring Keypad driver)
  // ---------------------------------------------------------------------------

  registerKeypad(device) {
    this.keypads.add(device);
  }

  unregisterKeypad(device) {
    this.keypads.delete(device);
  }

  /** Run `fn(device)` on every keypad, never letting one failure stop the rest. */
  _keypads(fn) {
    for (const device of this.keypads) {
      Promise.resolve().then(() => fn(device)).catch(err => this.error('[keypad]', err.message));
    }
  }

  /** Emergency button held on a keypad. */
  async keypadEmergency(button, device) {
    this.log(`Emergency button ${button} on ${device.getName()}`);
    try {
      this.homey.flow.getDeviceTriggerCard('ring_keypad_emergency').trigger(device, { button }).catch(err => this.error(err));
    } catch (err) {
      this.error(err);
    }
    this._trigger('panic', { user: device.getName(), action: button });
    if (button === 'police' && device.getSetting('policeTriggersAlarm') !== false) {
      this.engine.triggerAlarm('police', { id: device.getId(), name: device.getName() });
    }
  }

  /** Paired keypads for the settings page. */
  getKeypadList() {
    const out = [];
    for (const device of this.keypads) {
      let zone = null;
      try { zone = device.getSetting('zone') || null; } catch (err) { /* ignore */ }
      out.push({
        id: device.getId(),
        name: device.getName(),
        battery: device.getCapabilityValue('measure_battery'),
        tamper: device.getCapabilityValue('alarm_tamper'),
        available: device.getAvailable(),
        alarmSound: device.getSetting('alarmSound'),
        policeTriggersAlarm: device.getSetting('policeTriggersAlarm') !== false,
        zone,
      });
    }
    return out;
  }

  triggerKeypadCode(device, tokens) {
    try {
      this.homey.flow.getDeviceTriggerCard('ring_keypad_code')
        .trigger(device, { accepted: tokens.accepted, user: tokens.user || '', action: tokens.action || '' })
        .catch(err => this.error(err));
    } catch (err) {
      this.error(err);
    }
  }

  /** Post to the Homey timeline when the user enabled it for this event kind. */
  _timeline(kind, excerpt) {
    if (!this.getTimelineSettings()[kind]) return;
    this.homey.notifications.createNotification({ excerpt }).catch(err => this.error('timeline:', err.message));
  }

  /** Keep the include/exclude flag across restarts by writing an override. */
  _persistSensorEnabled(id, enabled) {
    const overrides = this.homey.settings.get(SETTINGS.sensors) || [];
    let entry = overrides.find(s => s.id === id);
    if (!entry) {
      const current = this.engine.listSensors().find(s => s.id === id);
      if (!current) return;
      entry = { id, modes: current.modes, entryDelay: current.entryDelay };
      overrides.push(entry);
    }
    if (entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.homey.settings.set(SETTINGS.sensors, overrides);
  }

  /** Include (true) or exclude/bypass (false) a configured sensor. */
  setSensorEnabled(id, enabled) {
    return this.engine.setSensorEnabled(id, enabled);
  }

  _updatePanelDevices(values) {
    for (const device of this._panelDevices()) {
      for (const [cap, value] of Object.entries(values)) {
        if (!device.hasCapability(cap)) continue;
        device.setCapabilityValue(cap, value).catch(err => this.error(`setCapabilityValue ${cap}:`, err.message));
      }
    }
  }

  /** Fire an app trigger card; `state` is what run listeners compare args against. */
  _trigger(id, tokens, state = tokens) {
    try {
      this.homey.flow.getTriggerCard(id).trigger(tokens, state).catch(err => this.error(`trigger ${id}:`, err.message));
    } catch (err) {
      this.error(`trigger card ${id} missing:`, err.message);
    }
  }

  /** Fire a device-scoped trigger card for every panel device (normally one). */
  _triggerDevice(id, tokens) {
    for (const device of this._panelDevices()) {
      try {
        this.homey.flow.getDeviceTriggerCard(id).trigger(device, tokens).catch(err => this.error(`device trigger ${id}:`, err.message));
      } catch (err) {
        this.error(`device trigger card ${id} missing:`, err.message);
      }
    }
  }

  _zoneOf(sensorId) {
    const row = this._sensorById.get(sensorId);
    return row && row.zone ? row.zone : null;
  }

  /** Device name without the "(zone)" suffix the engine names carry. */
  _plainName(sensorId, fallback) {
    const row = this._sensorById.get(sensorId);
    return row && row.deviceName ? row.deviceName : fallback;
  }

  /**
   * Public row for one engine sensor, as the widgets and the event log see it:
   * plain device name, zone apart, no secrets.
   */
  _sensorRow(s) {
    return {
      id: s.id, deviceId: s.deviceId, name: this._plainName(s.id, s.name), capability: s.capability,
      modes: s.modes, enabled: s.enabled, active: s.active,
      zone: this._zoneOf(s.id), lastActiveAt: s.lastActiveAt, lastChangedAt: s.lastChangedAt,
    };
  }

  /** Panel devices of this app (normally one); [] while the driver is not ready. */
  _panelDevices() {
    try {
      return this.homey.drivers.getDriver('panel').getDevices();
    } catch (err) {
      return [];
    }
  }

  /**
   * Zone picker of the "Sensor status" widget: the zones that currently hold
   * a sensor of this alarm, plus "all". Ids are zone names, which is all the
   * sensor table knows.
   */
  _registerWidgets() {
    const zones = async (query = '') => {
      const names = [...new Set((this._sensorTable || []).map(s => s.zone).filter(Boolean))].sort();
      const q = String(query).toLowerCase();
      return [{ id: '', name: this.homey.__('sensors_widget.all_zones') }, ...names.map(n => ({ id: n, name: n }))]
        .filter(z => !q || z.name.toLowerCase().includes(q));
    };
    for (const id of ['sensors', 'timeline']) {
      try {
        this.homey.dashboards.getWidget(id).registerSettingAutocompleteListener('zone', zones);
      } catch (err) {
        this.error(`widget ${id} registration:`, err.message);
      }
    }
  }

  /**
   * Recent changes for the timeline widget: sensor open/close plus arm, disarm
   * and alarm markers. Newest first, at most EVENT_LOG_SIZE, memory only (a
   * restart starts an empty log), no user names.
   */
  _logEvent(entry) {
    this._eventsVersion += 1;
    this._events.push({ at: Date.now(), ...entry });
    if (this._events.length > EVENT_LOG_SIZE) this._events.splice(0, this._events.length - EVENT_LOG_SIZE);
  }

  getEvents() {
    return { mode: this.engine.mode, phase: this.engine.phase, events: this._events.slice().reverse() };
  }

  /** Push status to widgets and the settings page. */
  _broadcast() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = this.homey.setTimeout(() => {
      this._broadcastTimer = null;
      this.homey.api.realtime('status', this.getStatus()).catch(() => {});
    }, 50);
  }

  // ---------------------------------------------------------------------------
  // Public API used by api.js, the widget and the panel device
  // ---------------------------------------------------------------------------

  /**
   * Public status: served to every dashboard viewer, so it carries only what
   * the widgets and the panel need. No codes, no user names, no panic hint,
   * and of the configuration only the two delays the countdown ring draws.
   */
  getStatus() {
    const { config, ...status } = this.engine.getStatus();
    return {
      ...status,
      config: { exitDelay: config.exitDelay, exitDelayHome: config.exitDelayHome, entryDelay: config.entryDelay },
      hasUsers: this.pins.hasUsers(),
      keypad: this.getKeypadSettings(),
      sensorCount: this.engine.sensors.size,
      eventsVersion: this._eventsVersion, // bumps on every event log entry
      // Per-sensor rows for the widget's list views. Names and open state are
      // already public through openSensors/excludedSensors; nothing secret here.
      // One row per capability; the widgets fold a device's tamper row into
      // its main row by deviceId.
      sensors: this.engine.listSensors().map(s => this._sensorRow(s)),
    };
  }

  /**
   * Mode change without PIN, from flows and the device tile. Whoever can reach
   * those already has Homey access, matching how Heimdall behaves.
   */
  setMode(mode, ctx = {}) {
    return this.engine.requestMode(mode, ctx);
  }

  /**
   * Keypad entry from the widget or another app. Verifies the PIN (including
   * the silent panic suffix), applies permissions, then performs the action.
   * A panic entry behaves exactly like a normal one towards the caller.
   * @param {object} opts { pin, action: 'armed'|'partially_armed'|'disarmed'|'deactivate'|'cancel', clientKey, pinForArm }
   */
  async keypad({ pin, action, clientKey = 'widget', source = 'widget' }) {
    const isArm = action === 'armed' || action === 'partially_armed';
    // Whether arming needs a code is an app setting; callers cannot relax it.
    const needsPin = !(isArm && this.getKeypadSettings().pinForArm === false);

    let user = null;
    let panic = false;
    if (needsPin) {
      const verdict = await this.pins.verify(pin, clientKey, { panicSuffix: this.getPanicSuffix() });
      if (!verdict.ok) {
        this._trigger('pin_rejected', { reason: verdict.reason, source });
        return { ok: false, reason: verdict.reason, retryAfter: verdict.retryAfter, attemptsLeft: verdict.attemptsLeft };
      }
      user = verdict.user;
      panic = verdict.panic;
      if (isArm && !user.canArm) return { ok: false, reason: 'not_allowed' };
      if (!isArm && !user.canDisarm) return { ok: false, reason: 'not_allowed' };
      this._trigger('pin_accepted', { user: user.name, action });
    }

    const ctx = { source, user: user ? user.name : null, panic };
    let result;
    switch (action) {
      case 'armed':
      case 'partially_armed':
      case 'disarmed':
        result = this.engine.requestMode(action, ctx);
        break;
      case 'deactivate':
        result = { ok: this.engine.deactivateAlarm(ctx) };
        break;
      case 'cancel':
        result = { ok: this.engine.cancelCountdown(ctx) };
        break;
      default:
        result = { ok: false, reason: 'invalid_action' };
    }

    if (panic && user) {
      // Silent: no timeline entry, nothing in the widget response.
      this.log(`Panic code used by ${user.name} (${action})`);
      this._trigger('panic', { user: user.name, action });
    }
    return { ...result, user: user ? user.name : null };
  }

  /**
   * Cancel the running countdown from a keypad key without a code. Only an
   * exit countdown may be cancelled that way (you changed your mind about
   * leaving); cancelling an entry countdown is a disarm and needs a code.
   */
  cancelFromKeypad(source = 'keypad') {
    if (this.engine.countdown.type !== 'exit') return { ok: false, reason: 'pin_required' };
    const sec = this.homey.settings.get(SETTINGS.security) || {};
    if (sec.exitCancelNeedsCode === true) return { ok: false, reason: 'pin_required' };
    return { ok: this.engine.cancelCountdown({ source }) };
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  _registerFlowCards() {
    const flow = this.homey.flow;

    flow.getTriggerCard('mode_changed').registerRunListener(async (args, state) => {
      return !args.mode || args.mode === 'any' || args.mode === state.mode;
    });
    flow.getTriggerCard('countdown_tick').registerRunListener(async (args, state) => {
      return !args.type || args.type === 'any' || args.type === state.type;
    });

    flow.getConditionCard('mode_is').registerRunListener(async args => this.engine.mode === args.mode);
    flow.getConditionCard('alarm_active').registerRunListener(async () => this.engine.phase === 'alarm');
    flow.getConditionCard('alarm_pending').registerRunListener(async () => this.engine.phase === 'entry');
    flow.getConditionCard('countdown_running').registerRunListener(async () => this.engine.isCountdownRunning());
    flow.getConditionCard('sensors_open').registerRunListener(async args => {
      const mode = args.mode && args.mode !== 'any' ? args.mode : null;
      return this.engine.getActiveSensors(mode).length > 0;
    });

    flow.getActionCard('set_mode').registerRunListener(async args => {
      this.assertFlowMayDisarm(args.mode);
      const res = this.engine.requestMode(args.mode, { source: 'flow' });
      if (!res.ok) throw new Error(this._reasonText(res));
      return true;
    });
    flow.getActionCard('set_mode_with_pin').registerRunListener(async args => {
      const res = await this.keypad({ pin: String(args.pin || ''), action: args.mode, clientKey: 'flow', source: 'flow' });
      if (!res.ok) throw new Error(this._reasonText(res));
      return true;
    });
    // Physical keypads (Ring Keypad via the Ring Security app, frient, ...):
    // one card takes the entered code and the pressed key straight from the
    // keypad's "Key sequence entered" trigger tags.
    flow.getActionCard('keypad_entry').registerRunListener(async args => {
      let action = mapKeypadKey(args.key);
      if (!action) throw new Error(this.homey.__('errors.unknown_key', { key: String(args.key || '') }));
      if (action === 'enter') action = resolveEnter(this.engine.getStatus());
      const clientKey = `keypad:${String(args.keypad || 'default').slice(0, 64)}`;
      if (action === 'cancel') {
        // exit countdown: free; entry countdown: a code is required
        const free = this.cancelFromKeypad('keypad');
        if (free.ok) return true;
        action = 'cancel';
      }
      const res = await this.keypad({ pin: String(args.pin || ''), action, clientKey, source: 'keypad' });
      if (!res.ok) throw new Error(this._reasonText(res));
      return true;
    });

    flow.getActionCard('deactivate_alarm').registerRunListener(async () => {
      this.assertFlowMayWeaken();
      this.engine.deactivateAlarm({ source: 'flow' });
      return true;
    });
    flow.getActionCard('trigger_alarm').registerRunListener(async args => {
      this.engine.triggerAlarm(args.reason || 'flow');
      return true;
    });
    flow.getActionCard('cancel_countdown').registerRunListener(async () => {
      if (this.engine.countdown.type === 'entry') this.assertFlowMayWeaken();
      this.engine.cancelCountdown({ source: 'flow' });
      return true;
    });

    // Include / exclude sensors. The argument is an autocomplete over the
    // sensors currently known to the engine.
    const sensorAutocomplete = async query => {
      const q = String(query || '').toLowerCase();
      return this.engine.listSensors()
        .filter(s => s.name.toLowerCase().includes(q))
        .map(s => ({ id: s.id, name: s.name, description: s.enabled ? '' : this.homey.__('flow.excluded') }));
    };
    const sensorCards = [
      flow.getActionCard('exclude_sensor'),
      flow.getActionCard('include_sensor'),
      flow.getConditionCard('sensor_excluded'),
    ];
    for (const card of sensorCards) card.registerArgumentAutocompleteListener('sensor', sensorAutocomplete);

    sensorCards[0].registerRunListener(async args => {
      this.assertFlowMayWeaken();
      if (!this.engine.setSensorEnabled(args.sensor.id, false)) throw new Error(this.homey.__('errors.unknown_sensor'));
      return true;
    });
    sensorCards[1].registerRunListener(async args => {
      if (!this.engine.setSensorEnabled(args.sensor.id, true)) throw new Error(this.homey.__('errors.unknown_sensor'));
      return true;
    });
    sensorCards[2].registerRunListener(async args => !this.engine.isSensorEnabled(args.sensor.id));
  }

  _reasonText(res) {
    switch (res.reason) {
      case 'sensors_open':
        return this.homey.__('errors.sensors_open', { sensors: (res.sensors || []).map(s => s.name).join(', ') });
      case 'invalid':
        return this.homey.__('errors.invalid_pin');
      case 'locked':
        return this.homey.__('errors.locked', { seconds: res.retryAfter || 0 });
      case 'no_users':
        return this.homey.__('errors.no_users');
      case 'not_allowed':
        return this.homey.__('errors.not_allowed');
      case 'disabled':
        return this.homey.__('errors.disabled');
      case 'pin_required':
        return this.homey.__('errors.pin_required');
      case 'alarm_active':
        return this.homey.__('errors.alarm_active');
      case 'alarm_pending':
        return this.homey.__('errors.alarm_pending');
      default:
        return this.homey.__('errors.generic');
    }
  }

};
