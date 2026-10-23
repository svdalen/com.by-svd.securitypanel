'use strict';

/**
 * Drives optional output devices from the alarm state:
 *  - sirens: any device with `onoff`, switched on while the alarm sounds
 *    (after the entry delay) and off when it ends.
 *  - LED lights/strips: colour follows the state. Disarmed shows green and
 *    switches off after a while; armed and partially armed can stay on or
 *    switch off after a while; countdowns and alarm have their own colours.
 *
 * Colours are hues in 0..1 (Homey's light_hue), `null` means "off".
 */
const DEFAULT_LED = Object.freeze({
  devices: [],
  colors: {
    armed: 0,            // red
    partially_armed: 0.08, // orange
    countdown: 0.15,     // yellow (exit and entry delay)
    alarm: 0,            // red
    disarmed: 0.33,      // green
  },
  disarmedOffAfter: 20,  // seconds, 0 = keep showing
  armedOffAfter: 0,      // seconds, 0 = keep showing
  brightness: 1,
});

class Indicators {

  /**
   * @param {object} opts
   * @param {{ setCapabilities: Function, getDeviceCapabilities: Function }} opts.bridge
   * @param {Function} opts.setTimeout
   * @param {Function} opts.clearTimeout
   */
  constructor({ bridge, setTimeout, clearTimeout, log = () => {}, error = () => {} }) {
    this._bridge = bridge;
    this._setTimeout = setTimeout;
    this._clearTimeout = clearTimeout;
    this._log = log;
    this._error = error;

    this.sirens = [];
    this.led = { ...DEFAULT_LED, colors: { ...DEFAULT_LED.colors } };
    this._ledCaps = new Map(); // deviceId -> capabilities[]
    this._offTimer = null;
    this._lastLedKey = null;
  }

  async configure({ sirens, leds } = {}) {
    if (Array.isArray(sirens)) this.sirens = sirens.filter(Boolean);
    if (leds && typeof leds === 'object') {
      this.led = {
        ...DEFAULT_LED,
        ...leds,
        colors: { ...DEFAULT_LED.colors, ...(leds.colors || {}) },
        devices: Array.isArray(leds.devices) ? leds.devices.filter(Boolean) : [],
      };
    }
    this._ledCaps.clear();
    for (const id of this.led.devices) {
      try {
        this._ledCaps.set(id, await this._bridge.getDeviceCapabilities(id));
      } catch (err) {
        this._error(`LED ${id}: ${err.message}`);
      }
    }
    this._lastLedKey = null; // force re-apply on next status
  }

  // ---------------------------------------------------------------------------
  // Sirens
  // ---------------------------------------------------------------------------

  /**
   * Switch all sirens. Calls are serialised and only the most recently
   * requested state wins, so a disarm right after an alarm can never leave a
   * slow siren on.
   */
  setSirens(on) {
    this._sirenWanted = Boolean(on);
    this._sirenGen = (this._sirenGen || 0) + 1;
    const gen = this._sirenGen;
    this._sirenChain = (this._sirenChain || Promise.resolve()).then(async () => {
      if (gen !== this._sirenGen) return; // superseded
      for (const id of this.sirens) {
        await this._bridge.setCapabilities(id, { onoff: this._sirenWanted });
      }
    }).catch(err => this._error(`sirens: ${err.message}`));
    return this._sirenChain;
  }

  // ---------------------------------------------------------------------------
  // LEDs
  // ---------------------------------------------------------------------------

  /**
   * Apply the LED colour for an engine status { mode, phase }.
   * Safe to call often; only changes are sent to the devices.
   */
  async applyLed({ mode, phase }) {
    if (this.led.devices.length === 0) return;

    let key;
    let hue;
    let offAfter = 0;
    if (phase === 'alarm') {
      key = 'alarm'; hue = this.led.colors.alarm;
    } else if (phase === 'arming' || phase === 'entry') {
      key = 'countdown'; hue = this.led.colors.countdown;
    } else if (mode === 'armed') {
      key = 'armed'; hue = this.led.colors.armed; offAfter = this.led.armedOffAfter;
    } else if (mode === 'partially_armed') {
      key = 'partially_armed'; hue = this.led.colors.partially_armed; offAfter = this.led.armedOffAfter;
    } else {
      key = 'disarmed'; hue = this.led.colors.disarmed; offAfter = this.led.disarmedOffAfter;
    }

    if (key === this._lastLedKey) return;
    this._lastLedKey = key;
    this._clearOffTimer();

    if (hue === null || hue === undefined || hue === '') {
      await this._allOff();
      return;
    }

    await this._allColor(Number(hue));

    if (offAfter > 0) {
      this._offTimer = this._setTimeout(() => {
        this._offTimer = null;
        this._allOff().catch(err => this._error(err.message));
      }, offAfter * 1000);
    }
  }

  async _allColor(hue) {
    for (const id of this.led.devices) {
      const caps = this._ledCaps.get(id) || [];
      const values = {};
      if (caps.includes('onoff')) values.onoff = true;
      if (caps.includes('light_mode')) values.light_mode = 'color';
      if (caps.includes('light_hue')) values.light_hue = clamp01(hue);
      if (caps.includes('light_saturation')) values.light_saturation = 1;
      if (caps.includes('dim')) values.dim = clamp01(this.led.brightness);
      await this._bridge.setCapabilities(id, values);
    }
  }

  async _allOff() {
    for (const id of this.led.devices) {
      await this._bridge.setCapabilities(id, { onoff: false });
    }
  }

  _clearOffTimer() {
    if (this._offTimer) {
      this._clearTimeout(this._offTimer);
      this._offTimer = null;
    }
  }

  destroy() {
    this._clearOffTimer();
  }

}

function clamp01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

Indicators.DEFAULT_LED = DEFAULT_LED;

module.exports = Indicators;
