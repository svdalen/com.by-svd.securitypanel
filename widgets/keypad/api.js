'use strict';

module.exports = {

  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  /**
   * body: { pin, action, instanceId }
   * The code is verified in the app, never in the browser. Lockouts are kept
   * per widget instance and globally, so rotating instance ids does not help.
   * Whether arming needs a code is an app setting the client cannot override.
   */
  async postKeypad({ homey, body }) {
    const instanceId = body && typeof body.instanceId === 'string' ? body.instanceId.slice(0, 64) : 'unknown';
    const result = await homey.app.keypad({
      pin: body && typeof body.pin === 'string' ? body.pin : '',
      action: body && body.action,
      clientKey: `widget:${instanceId}`,
      source: 'widget',
    });
    const { user, ...publicResult } = result; // never tell the browser who matched
    return { ...publicResult, status: homey.app.getStatus() };
  },

};
