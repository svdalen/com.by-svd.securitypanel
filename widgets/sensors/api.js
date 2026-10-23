'use strict';

module.exports = {

  /** Same public status the keypad widget gets: sensor names and states, never codes or users. */
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

};
