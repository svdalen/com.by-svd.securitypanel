'use strict';

/**
 * App API. Reachable by the settings page (`Homey.api(...)`) and by other
 * apps / the Web API at `/api/app/<app id>/...` for every logged-in Homey
 * user, including guests. Therefore nothing here weakens the alarm without a
 * valid user code, and user management is not exposed here at all (the
 * settings page saves users through a setting, which only owners and
 * managers can reach).
 */

/**
 * Verify a code from the request body; returns the user or throws. With no
 * users configured this fails closed, like the keypad: nothing that weakens
 * the alarm is reachable without a code, not even on a fresh install.
 */
async function requireCode(homey, body, { canDisarm = true } = {}) {
  const pin = body && typeof body.pin === 'string' ? body.pin : '';
  const verdict = await homey.app.pins.verify(pin, 'api', { panicSuffix: homey.app.getPanicSuffix() });
  if (!verdict.ok) throw new Error(homey.app._reasonText(verdict));
  if (canDisarm && !verdict.user.canDisarm) throw new Error(homey.app._reasonText({ reason: 'not_allowed' }));
  return verdict.user;
}

module.exports = {

  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  /** Every sensor on Homey with its effective alarm configuration. */
  async getSensors({ homey }) {
    return homey.app.getSensorTable();
  },

  /** body: { id, enabled, pin } — including is free, excluding needs a user code. */
  async putSensorEnabled({ homey, body }) {
    const enabled = Boolean(body && body.enabled);
    if (!enabled) await requireCode(homey, body);
    const ok = homey.app.setSensorEnabled(body && body.id, enabled);
    if (!ok) throw new Error('Unknown sensor');
    return { ok: true, status: homey.app.getStatus() };
  },

  /** Keypads paired directly to this app (Ring Keypad driver). */
  async getKeypads({ homey }) {
    return homey.app.getKeypadList();
  },

  async getPanels({ homey }) {
    if (!homey.app.monitor) throw new Error('Monitor not connected');
    return homey.app.monitor.listAvailablePanels();
  },

  /**
   * Device picker. query: capabilities=onoff,dim (all required) and
   * classes=light,socket (any). Used for sirens and LED strips.
   */
  async getDevices({ homey, query }) {
    if (!homey.app.monitor) throw new Error('Monitor not connected');
    const split = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    return homey.app.monitor.listDevices({
      capabilities: split(query && query.capabilities),
      classes: split(query && query.classes),
    });
  },

  /** Names and permissions only; never codes. */
  async getUsers({ homey }) {
    return homey.app.pins.list();
  },

  /**
   * Mode change for other apps and integrations. Behaves exactly like a
   * keypad: arming may be code-free (app setting), disarming needs a code.
   * body: { mode, pin }
   */
  async putMode({ homey, body }) {
    const res = await homey.app.keypad({
      pin: body && typeof body.pin === 'string' ? body.pin : '',
      action: body && body.mode,
      clientKey: 'api',
      source: 'api',
    });
    if (!res.ok) throw new Error(homey.app._reasonText(res));
    const { user, ...result } = res;
    return result;
  },

  /**
   * body: { pin, action: 'armed'|'partially_armed'|'disarmed'|'deactivate'|'cancel', clientKey }
   * Like the widget endpoint, the matched user is not echoed back.
   */
  async postKeypad({ homey, body }) {
    const { user, ...result } = await homey.app.keypad({
      pin: body && typeof body.pin === 'string' ? body.pin : '',
      action: body && body.action,
      clientKey: body && body.clientKey ? `api:${String(body.clientKey).slice(0, 64)}` : 'api',
      source: 'api',
    });
    return result;
  },

  /** body: { pin } — silence the alarm but stay armed. */
  async postDeactivate({ homey, body }) {
    await requireCode(homey, body);
    return { ok: homey.app.engine.deactivateAlarm({ source: 'api' }) };
  },

};
