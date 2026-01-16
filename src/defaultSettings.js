/**
 * Default settings for the cgateweb bridge.
 * These can be overridden by user settings in settings.js
 */
const defaultSettings = {
    mqtt: 'localhost:1883',
    cbusip: 'your-cgate-ip',
    cbusname: 'CLIPSAL',
    cbuscommandport: 20023,
    cbuseventport: 20025,
    cgateusername: null,
    cgatepassword: null,
    retainreads: false,
    logging: true,
    messageinterval: 200,
    getallnetapp: null,
    getallonstart: false,
    getallperiod: null,
    mqttusername: null,
    mqttpassword: null,
    reconnectinitialdelay: 1000,
    reconnectmaxdelay: 60000,
    connectionPoolSize: 3,
    healthCheckInterval: 30000,
    keepAliveInterval: 60000,
    connectionTimeout: 5000,
    maxRetries: 3,
    ha_discovery_enabled: false,
    ha_discovery_prefix: 'homeassistant',
    ha_discovery_networks: [],
    ha_discovery_cover_app_id: '203',
    ha_discovery_switch_app_id: null,
    ha_discovery_relay_app_id: null,
    ha_discovery_pir_app_id: null
};

module.exports = { defaultSettings };
