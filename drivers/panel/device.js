'use strict';

const Homey = require('homey');

const CAPABILITIES = ['homealarm_state', 'alarm_sounding', 'alarm_pending', 'countdown_seconds'];
const LEGACY_CAPABILITIES = ['alarm_generic'];

/**
 * The panel is a thin view on the app's AlarmEngine. Homey's built-in
 * `homealarm_state` flow cards and the device tile work through it, and the
 * device carries its own clearly named flow cards (see driver.flow.compose.json).
 */
module.exports = class PanelDevice extends Homey.Device {

  async onInit() {
    // Existing devices were paired with class `homealarm`; a dashboard tap on
    // that class arms the device. Migrate to `sensor`, like Heimdall.
    if (this.getClass() !== 'sensor') {
      await this.setClass('sensor').catch(this.error);
    }
    for (const cap of LEGACY_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    this.registerCapabilityListener('homealarm_state', async value => {
      // The device tile (and Homey's built-in "Set state" card) cannot ask for
      // a PIN, and tapping an alarm tile on a dashboard can send a state change
      // by itself. Depending on the protection setting, refuse disarming or
      // any change here so the keypad widget stays the only unprivileged path.
      const protection = this.homey.app.getTileProtection();
      const current = this.homey.app.engine.mode;
      this.log(`homealarm_state set to ${value} from device tile/flow (current ${current}, protection ${protection})`);
      if (value === current) return;

      const revert = () => this.setCapabilityValue('homealarm_state', this.homey.app.engine.mode).catch(this.error);
      if (protection === 'all' || (protection === 'disarm' && value === 'disarmed')) {
        // Refuse: Homey shows the reason and keeps the old value, and a flow
        // using the built-in "Set state" card fails instead of silently doing nothing.
        this.homey.setTimeout(revert, 300);
        throw new Error(this.homey.__('errors.tile_protected'));
      }
      const res = this.homey.app.setMode(value, { source: 'device' });
      if (!res.ok) {
        throw new Error(this.homey.app._reasonText(res));
      }
      // When an exit delay runs, the capability stays on the old value until
      // the mode is really applied. Reflect that back to the UI.
      if (res.delayed) {
        this.homey.setTimeout(() => {
          this.setCapabilityValue('homealarm_state', this.homey.app.engine.mode).catch(this.error);
        }, 250);
      }
    });

    await this.syncFromEngine();
  }

  async syncFromEngine() {
    const status = this.homey.app.getStatus();
    await this.setCapabilityValue('homealarm_state', status.mode).catch(this.error);
    await this.setCapabilityValue('alarm_sounding', status.alarmActive).catch(this.error);
    await this.setCapabilityValue('alarm_pending', status.alarmPending).catch(this.error);
    await this.setCapabilityValue('countdown_seconds', status.countdown ? status.countdown.seconds : 0).catch(this.error);
  }

  async onAdded() {
    await this.syncFromEngine();
  }

};
