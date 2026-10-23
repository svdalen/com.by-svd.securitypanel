'use strict';

module.exports = {

  /** Recent sensor and system changes: names, states and times only, never codes or users. */
  async getEvents({ homey }) {
    return homey.app.getEvents();
  },

};
