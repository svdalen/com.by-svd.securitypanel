'use strict';

const Homey = require('homey');

module.exports = class PanelDriver extends Homey.Driver {

  async onInit() {
    this.log('Panel driver initialised');

    const flow = this.homey.flow;
    const engine = () => this.homey.app.engine;

    flow.getConditionCard('panel_is_armed').registerRunListener(async () => engine().mode === 'armed');
    flow.getConditionCard('panel_is_partially_armed').registerRunListener(async () => engine().mode === 'partially_armed');
    flow.getConditionCard('panel_is_disarmed').registerRunListener(async () => engine().mode === 'disarmed');
    flow.getConditionCard('panel_is_sounding').registerRunListener(async () => engine().phase === 'alarm');
    flow.getConditionCard('panel_is_triggered').registerRunListener(async () => engine().phase === 'entry');

    const setMode = mode => async () => {
      this.homey.app.assertFlowMayDisarm(mode);
      const res = engine().requestMode(mode, { source: 'flow' });
      if (!res.ok) throw new Error(this.homey.app._reasonText(res));
      return true;
    };
    flow.getActionCard('panel_arm').registerRunListener(setMode('armed'));
    flow.getActionCard('panel_partially_arm').registerRunListener(setMode('partially_armed'));
    flow.getActionCard('panel_disarm').registerRunListener(setMode('disarmed'));
    flow.getActionCard('panel_silence').registerRunListener(async () => {
      this.homey.app.assertFlowMayWeaken();
      engine().deactivateAlarm({ source: 'flow' });
      return true;
    });
  }

  /**
   * There is exactly one alarm engine, so only one panel device can exist.
   */
  async onPairListDevices() {
    if (this.getDevices().length > 0) {
      throw new Error(this.homey.__('pair.already_added'));
    }
    return [
      {
        name: this.homey.__('pair.device_name'),
        data: { id: 'panel' },
      },
    ];
  }

};
