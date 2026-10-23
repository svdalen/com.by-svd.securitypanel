'use strict';

const Homey = require('homey');

module.exports = class RingKeypadDriver extends Homey.Driver {

  async onInit() {
    const flow = this.homey.flow;

    flow.getActionCard('ring_keypad_chime').registerRunListener(async args => {
      await args.device.chime(args.chime, Number(args.volume));
      return true;
    });
    flow.getActionCard('ring_keypad_siren').registerRunListener(async args => {
      await args.device.siren(args.mode);
      return true;
    });
    this.log('Ring Keypad driver initialised');
  }

};
