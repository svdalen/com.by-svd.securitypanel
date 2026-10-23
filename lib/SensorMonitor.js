'use strict';

const SENSOR_CAPABILITIES = Object.freeze([
  'alarm_contact',
  'alarm_motion',
  'alarm_occupancy',
  'alarm_presence',
  'alarm_vibration',
  'alarm_tamper',
  'alarm_generic',
]);
const SENSOR_CAPABILITY_SET = new Set(SENSOR_CAPABILITIES);

// A device with one of these is a safety sensor (leak, smoke, CO, heat, gas),
// not an intrusion sensor: it stays out of the alarm unless the user includes it.
const SAFETY_CAPABILITIES = Object.freeze([
  'alarm_water',
  'alarm_smoke',
  'alarm_co',
  'alarm_co2',
  'alarm_heat',
  'alarm_fire',
  'alarm_gas',
]);
const SAFETY_CAPABILITY_SET = new Set(SAFETY_CAPABILITIES);

/**
 * Watches other Homey devices through the Web API (homey-api) and feeds
 * sensor state into the engine. Also mirrors the mode to and from "linked
 * panels": any other device with a `homealarm_state` capability, such as a
 * Ring Alarm basestation.
 */
class SensorMonitor {

  /**
   * @param {object} opts
   * @param {import('homey-api').HomeyAPIV3Local} opts.api
   * @param {string} opts.ownAppId  used to hide our own panel from pickers
   * @param {Function} opts.onSensor  (sensorId, value) => void
   * @param {Function} opts.onPanelMode  (deviceId, mode) => void
   * @param {Function} [opts.log]
   * @param {Function} [opts.error]
   */
  constructor({ api, ownAppId, onSensor, onPanelMode, onDevicesChanged = () => {}, log = () => {}, error = () => {} }) {
    this._api = api;
    this._ownAppId = ownAppId;
    this._onSensor = onSensor;
    this._onPanelMode = onPanelMode;
    this._onDevicesChanged = onDevicesChanged;
    this._log = log;
    this._error = error;

    this._sensorInstances = new Map(); // sensorId -> capability instance
    this._panelInstances = new Map();  // deviceId -> capability instance
    this._lastPushedPanelValue = new Map(); // deviceId -> mode we last wrote

    this._wantedSensors = [];
    this._wantedPanels = [];

    this._identity = new Map(); // deviceId -> `${name}|${zone}` as last listed, to spot renames and moves

    this._onDeviceCreate = this._onDeviceCreate.bind(this);
    this._onDeviceDelete = this._onDeviceDelete.bind(this);
    this._onDeviceUpdate = this._onDeviceUpdate.bind(this);
  }

  async start() {
    await this._api.devices.connect();
    this._api.devices.on('device.create', this._onDeviceCreate);
    this._api.devices.on('device.delete', this._onDeviceDelete);
    this._api.devices.on('device.update', this._onDeviceUpdate);
  }

  async stop() {
    this._api.devices.off('device.create', this._onDeviceCreate);
    this._api.devices.off('device.delete', this._onDeviceDelete);
    this._api.devices.off('device.update', this._onDeviceUpdate);
    for (const inst of this._sensorInstances.values()) safeDestroy(inst);
    for (const inst of this._panelInstances.values()) safeDestroy(inst);
    this._sensorInstances.clear();
    this._panelInstances.clear();
  }

  // ---------------------------------------------------------------------------
  // Discovery for the settings page
  // ---------------------------------------------------------------------------

  /** All devices on Homey that expose a supported alarm_* capability. */
  async listAvailableSensors() {
    const devices = await this._api.devices.getDevices();
    const zones = await this._safeGetZones();
    const out = [];
    this._identity.clear();
    for (const device of Object.values(devices)) {
      if (this._isOwn(device)) continue;
      const caps = (device.capabilities || []).filter(c => SENSOR_CAPABILITY_SET.has(c));
      const safety = (device.capabilities || []).some(c => SAFETY_CAPABILITY_SET.has(c));
      if (caps.length) this._identity.set(device.id, `${device.name}|${device.zone || ''}`);
      for (const capability of caps) {
        out.push({
          id: `${device.id}:${capability}`,
          deviceId: device.id,
          capability,
          safety,
          name: device.name,
          zone: zones[device.zone] ? zones[device.zone].name : null,
          iconObj: device.iconObj || null,
          value: device.capabilitiesObj && device.capabilitiesObj[capability]
            ? device.capabilitiesObj[capability].value
            : null,
        });
      }
    }
    out.sort((a, b) => `${a.zone || ''}${a.name}`.localeCompare(`${b.zone || ''}${b.name}`));
    return out;
  }

  /**
   * Generic device listing for pickers (sirens, LED strips, ...).
   * @param {object} filter { capabilities?: string[] (all required), classes?: string[] (any) }
   */
  async listDevices({ capabilities = [], classes = [] } = {}) {
    const devices = await this._api.devices.getDevices();
    const zones = await this._safeGetZones();
    const out = [];
    for (const device of Object.values(devices)) {
      if (this._isOwn(device)) continue;
      const caps = device.capabilities || [];
      if (capabilities.some(c => !caps.includes(c))) continue;
      if (classes.length && !classes.includes(device.class)) continue;
      out.push({
        id: device.id,
        name: device.name,
        class: device.class,
        zone: zones[device.zone] ? zones[device.zone].name : null,
        capabilities: caps,
      });
    }
    out.sort((a, b) => `${a.zone || ''}${a.name}`.localeCompare(`${b.zone || ''}${b.name}`));
    return out;
  }

  /** Capability ids of one device, or [] when unknown. */
  async getDeviceCapabilities(deviceId) {
    const devices = await this._api.devices.getDevices();
    const device = devices[deviceId];
    return device ? (device.capabilities || []) : [];
  }

  /** Set several capabilities on another device; failures are logged, not thrown. */
  async setCapabilities(deviceId, values) {
    for (const [capabilityId, value] of Object.entries(values)) {
      try {
        await this._api.devices.setCapabilityValue({ deviceId, capabilityId, value });
      } catch (err) {
        this._error(`set ${capabilityId} on ${deviceId}: ${err.message}`);
      }
    }
  }

  /** Other alarm panels on Homey (e.g. Ring basestation) that can be mirrored. */
  async listAvailablePanels() {
    const devices = await this._api.devices.getDevices();
    const out = [];
    for (const device of Object.values(devices)) {
      if (this._isOwn(device)) continue;
      if (!(device.capabilities || []).includes('homealarm_state')) continue;
      out.push({
        id: device.id,
        name: device.name,
        driverId: device.driverId || device.driverUri || null,
        value: device.capabilitiesObj && device.capabilitiesObj.homealarm_state
          ? device.capabilitiesObj.homealarm_state.value
          : null,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /**
   * @param {Array<{id:string, deviceId:string, capability:string}>} sensors
   */
  async watchSensors(sensors = []) {
    this._wantedSensors = sensors;
    const wanted = new Set(sensors.map(s => s.id));

    for (const [id, inst] of this._sensorInstances) {
      if (!wanted.has(id)) {
        safeDestroy(inst);
        this._sensorInstances.delete(id);
      }
    }

    const devices = await this._api.devices.getDevices();
    for (const sensor of sensors) {
      if (this._sensorInstances.has(sensor.id)) continue;
      const device = devices[sensor.deviceId];
      if (!device) {
        this._log(`Sensor device ${sensor.deviceId} not found (yet)`);
        continue;
      }
      this._subscribeSensor(device, sensor);
    }
  }

  _subscribeSensor(device, sensor) {
    try {
      const inst = device.makeCapabilityInstance(sensor.capability, value => {
        this._onSensor(sensor.id, value);
      });
      this._sensorInstances.set(sensor.id, inst);
      // seed the current value so an already-open door is known immediately,
      // without treating it as a fresh trip
      const cur = device.capabilitiesObj && device.capabilitiesObj[sensor.capability];
      if (cur && cur.value !== null && cur.value !== undefined) {
        const at = cur.lastUpdated ? Date.parse(cur.lastUpdated) : NaN;
        this._onSensor(sensor.id, cur.value, { seed: true, at: Number.isFinite(at) ? at : null });
      }
    } catch (err) {
      this._error(`Could not subscribe to ${device.name} ${sensor.capability}: ${err.message}`);
    }
  }

  /**
   * @param {string[]} deviceIds
   */
  async watchPanels(deviceIds = []) {
    this._wantedPanels = deviceIds;
    const wanted = new Set(deviceIds);

    for (const [id, inst] of this._panelInstances) {
      if (!wanted.has(id)) {
        safeDestroy(inst);
        this._panelInstances.delete(id);
        this._lastPushedPanelValue.delete(id);
      }
    }

    const devices = await this._api.devices.getDevices();
    for (const deviceId of deviceIds) {
      if (this._panelInstances.has(deviceId)) continue;
      const device = devices[deviceId];
      if (!device) continue;
      this._subscribePanel(device);
    }
  }

  _subscribePanel(device) {
    try {
      const inst = device.makeCapabilityInstance('homealarm_state', value => {
        // Ignore the echo of a value we just wrote ourselves, but only for a
        // few seconds: if the other panel refused or changed its mind, a later
        // genuine change to that same value must still come through.
        const pushed = this._lastPushedPanelValue.get(device.id);
        if (pushed) {
          this._lastPushedPanelValue.delete(device.id);
          if (pushed.value === value && Date.now() - pushed.at < 5000) return;
        }
        this._onPanelMode(device.id, value, device.name);
      });
      this._panelInstances.set(device.id, inst);
    } catch (err) {
      this._error(`Could not subscribe to panel ${device.name}: ${err.message}`);
    }
  }

  /** Push our mode to all linked panels. */
  async pushMode(mode) {
    for (const [deviceId, inst] of this._panelInstances) {
      try {
        if (inst.value === mode) continue;
        this._lastPushedPanelValue.set(deviceId, { value: mode, at: Date.now() });
        await inst.setValue(mode);
      } catch (err) {
        this._lastPushedPanelValue.delete(deviceId);
        this._error(`Could not set mode on panel ${deviceId}: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Device lifecycle
  // ---------------------------------------------------------------------------

  _onDeviceCreate(device) {
    // A sensor or panel we wanted may have just (re)appeared, or a brand new
    // sensor arrived that the app may want to include automatically. The app
    // rebuilds (debounced), which re-subscribes everything it wants.
    this._onDevicesChanged({ type: 'create', device });
  }

  /** A rename or a move to another zone changes what the widgets show. */
  _onDeviceUpdate(device) {
    const id = device && device.id;
    if (!id || !this._identity.has(id)) return;
    const identity = `${device.name}|${device.zone || ''}`;
    if (identity === this._identity.get(id)) return;
    this._identity.set(id, identity);
    this._onDevicesChanged({ type: 'update', device });
  }

  _onDeviceDelete(device) {
    const id = device && device.id;
    if (!id) return;
    for (const [sensorId, inst] of this._sensorInstances) {
      if (sensorId.startsWith(`${id}:`)) {
        safeDestroy(inst);
        this._sensorInstances.delete(sensorId);
      }
    }
    const panel = this._panelInstances.get(id);
    if (panel) {
      safeDestroy(panel);
      this._panelInstances.delete(id);
    }
    this._onDevicesChanged({ type: 'delete', device });
  }

  _isOwn(device) {
    const uri = device.driverUri || device.ownerUri || '';
    const driverId = device.driverId || '';
    return uri.includes(this._ownAppId) || driverId.includes(this._ownAppId);
  }

  async _safeGetZones() {
    try {
      return await this._api.zones.getZones();
    } catch (err) {
      return {};
    }
  }

}

function safeDestroy(inst) {
  try {
    inst.destroy();
  } catch (err) {
    // ignore
  }
}

SensorMonitor.SENSOR_CAPABILITIES = SENSOR_CAPABILITIES;
SensorMonitor.SAFETY_CAPABILITIES = SAFETY_CAPABILITIES;

module.exports = SensorMonitor;
