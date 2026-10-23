'use strict';

const { ZwaveDevice } = require('homey-zwavedriver');
const R = require('../../lib/ringIndicators');
const { mapKeypadKey, resolveEnter } = require('../../lib/keypadKeys');

const EMERGENCY_KEYS = Object.freeze({
  POLICE: 'police',
  FIRE: 'fire',
  ALERT_MEDICAL: 'medical',
  ALERT_PANIC: 'police',
});

/**
 * Ring Keypad (gen 1 and gen 2) paired directly to Homey over Z-Wave and
 * wired straight into the Security Panel engine: codes and mode buttons go
 * to the app, the app drives the keypad's lights, delay bar and siren.
 */
module.exports = class RingKeypadDevice extends ZwaveDevice {

  async onNodeInit() {
    this.registerCapability('measure_battery', 'BATTERY');

    // Codes and buttons. The payload field names come from Homey's Z-Wave
    // parser for COMMAND_CLASS_ENTRY_CONTROL.
    this.registerReportListener('ENTRY_CONTROL', 'ENTRY_CONTROL_NOTIFICATION', report => {
      this._onEntryControl(report).catch(err => this.error('entry control:', err));
    });

    // Tamper: cover removed (Home Security) or unplugged (Power Management).
    this.registerReportListener('NOTIFICATION', 'NOTIFICATION_REPORT', report => this._onNotification(report));

    this.homey.app.registerKeypad(this);

    // Re-sync after an app restart or update, but silently: the mode light is
    // also the keypad's spoken announcement, so only send it when the mode
    // actually differs from what this keypad last showed.
    const status = this.homey.app.getStatus();
    const lastShown = this.getStoreValue('lastShownMode');
    if (status.phase !== 'armed' && status.phase !== 'idle') {
      await this.showState(status).catch(err => this.error(err));
    } else if (lastShown !== status.mode) {
      await this.showMode(status.mode).catch(err => this.error(err));
    } else {
      this.log(`startup: keypad already shows ${status.mode}, staying quiet`);
    }
    this.log('Ring Keypad ready');
  }

  onDeleted() {
    this.homey.app.unregisterKeypad(this);
    super.onDeleted();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  async _onEntryControl(report) {
    const eventType = String(report['Event Type'] || '').toUpperCase();
    if (!eventType || eventType === 'CACHING' || eventType === 'CACHED_KEYS') return;

    const code = report['Event Data Length'] > 0 || report['Event Data'] ? R.decodeEntryCode(report['Event Data']) : '';
    this.log(`entry control: ${eventType} (${code.length} digits)`);

    const emergency = EMERGENCY_KEYS[eventType];
    if (emergency) {
      await this.homey.app.keypadEmergency(emergency, this);
      return;
    }

    let action = mapKeypadKey(eventType);
    if (!action) {
      this.log(`ignoring unknown key ${eventType}`);
      return;
    }
    if (action === 'cancel') {
      // Cancelling an exit countdown is free (changed your mind about
      // leaving). Cancelling an entry countdown is a disarm: code required.
      const free = this.homey.app.cancelFromKeypad('keypad');
      if (free.ok) {
        await this.send(R.feedbackIndicator(true));
        return;
      }
    }
    if (action === 'enter') action = resolveEnter(this.homey.app.getStatus());

    const result = await this.homey.app.keypad({
      pin: code,
      action,
      clientKey: `zwave:${this.getData().token || this.getId()}`,
      source: 'keypad',
    });
    await this.send(R.feedbackIndicator(Boolean(result.ok)));
    this.homey.app.triggerKeypadCode(this, { accepted: Boolean(result.ok), action, user: result.user || '' });
  }

  _onNotification(report) {
    if (this.getSetting('useTamper') === false) return;
    const type = String(report['Notification Type'] || '');
    const event = report['Event (Parsed)'] || report.Event;
    if (type === 'Home Security') {
      if (event === 'Tampering, Product covering removed' || event === 3) this.setCapabilityValue('alarm_tamper', true).catch(this.error);
      if (event === 'Previous Events cleared' || event === 0) this.setCapabilityValue('alarm_tamper', false).catch(this.error);
    } else if (type === 'Power Management') {
      if (event === 'AC mains disconnected' || event === 2) this.setCapabilityValue('alarm_tamper', true).catch(this.error);
      if (event === 'AC mains re-connected' || event === 'AC mains reconnected' || event === 3) this.setCapabilityValue('alarm_tamper', false).catch(this.error);
    }
  }

  // ---------------------------------------------------------------------------
  // Output: lights, delay bar, siren, chime
  // ---------------------------------------------------------------------------

  /** @returns {Promise<boolean>} true when the keypad acknowledged the frame */
  async send(command) {
    if (!this.node) return false;
    try {
      await this.node.sendCommand(command);
      return true;
    } catch (err) {
      // FLiRS keypads sometimes miss a beam; log and carry on.
      this.error('indicator:', err.message);
      return false;
    }
  }

  /** Reflect a full engine status (used at init and after an alarm ends). */
  async showState(status) {
    if (!status) return;
    if (status.phase === 'alarm') return this.showAlarm(true);
    if (status.phase === 'arming' && status.countdown) return this.showDelay('exit', status.countdown.seconds);
    if (status.phase === 'entry' && status.countdown) return this.showDelay('entry', status.countdown.seconds);
    return this.showMode(status.mode);
  }

  async showMode(mode) {
    // Only remember the mode when the keypad confirmed it, so a missed frame
    // is corrected at the next opportunity (next change or next app start).
    const ok = await this.send(R.modeIndicator(mode));
    await this.setStoreValue('lastShownMode', ok ? mode : null).catch(this.error);
  }

  /**
   * Exit or entry countdown. The keypad announces and counts down by itself
   * once it gets the duration; the device settings decide which countdowns
   * are announced at all.
   * @param {'exit'|'entry'} type
   * @param {number} seconds
   * @param {string} [mode] target mode for exit delays
   */
  async showDelay(type, seconds, mode) {
    if (type === 'exit') {
      const announce = mode === 'partially_armed'
        ? this.getSetting('announceExitHome') === true
        : this.getSetting('announceExitAway') !== false;
      if (!announce) return;
      const chime = this.getSetting('exitChime');
      if (chime && chime !== 'none') await this.send(R.chimeIndicator(chime, 3));
    } else if (this.getSetting('announceEntry') === false) {
      return;
    }
    await this.send(R.delayIndicator(type, seconds));
  }

  async showBypass() {
    await this.send(R.bypassIndicator());
  }

  async showAlarm(active, kind) {
    const sound = kind || this.getSetting('alarmSound') || 'burglar';
    if (sound === 'none') {
      // lights only: use the generic alarm light briefly then the mode light
      if (active) await this.send(R.alarmIndicator('generic', true));
      else await this.send(R.alarmIndicator('generic', false));
      return;
    }
    await this.send(R.alarmIndicator(sound, active));
  }

  async chime(name, volume) {
    await this.send(R.chimeIndicator(name, volume));
  }

  async siren(kind) {
    if (!kind || kind === 'off') {
      await this.send(R.alarmIndicator(this.getSetting('alarmSound') === 'none' ? 'generic' : (this.getSetting('alarmSound') || 'burglar'), false));
      await this.showMode(this.homey.app.engine.mode);
      return;
    }
    await this.send(R.alarmIndicator(kind, true));
  }

};
