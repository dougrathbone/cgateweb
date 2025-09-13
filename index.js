#!/usr/bin/env node

const CgateWebBridge = require('./src/cgateWebBridge');
const { validateWithWarnings } = require('./src/settingsValidator');
const ConfigLoader = require('./src/config/ConfigLoader');

// --- Default Settings (can be overridden by ./settings.js) ---
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

// --- Load Settings using ConfigLoader ---
let settings = defaultSettings;
try {
    const configLoader = new ConfigLoader();
    const loadedConfig = configLoader.load();
    settings = { ...defaultSettings, ...loadedConfig };
    
    // Log environment info
    const envInfo = configLoader.getEnvironment();
    console.log(`[INFO] Environment: ${envInfo.type}`);
    if (envInfo.details) {
        console.log(`[INFO] ${envInfo.details}`);
    }
    
    // Determine source from environment metadata
    const source = loadedConfig._environment ? loadedConfig._environment.type : 'unknown';
    console.log(`[INFO] Configuration loaded from: ${source}`);
} catch (error) {
    console.error(`[ERROR] Failed to load configuration: ${error.message}`);
    console.error('[ERROR] Using default settings only');
}


// Application startup
function main() {
    console.log('[INFO] Starting cgateweb...');
    console.log(`[INFO] Version: ${require('./package.json').version}`);
    
    validateWithWarnings(settings);
    
    // Create and start the bridge
    const bridge = new CgateWebBridge(settings);
    
    // Graceful shutdown handling
    const shutdown = (signal) => {
        console.log(`[INFO] Received ${signal}, shutting down gracefully...`);
        bridge.stop();
        process.exit(0);
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR1', () => {
        console.log('[INFO] Received SIGUSR1, reloading configuration...');
        // TODO: Implement configuration reload
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[ERROR] Uncaught exception:', error);
        bridge.stop();
        process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[ERROR] Unhandled promise rejection at:', promise, 'reason:', reason);
        bridge.stop();
        process.exit(1);
    });
    
    // Start the bridge (async)
    return bridge.start()
        .then(() => {
            console.log('[INFO] cgateweb started successfully');
        })
        .catch(error => {
            console.error('[ERROR] Failed to start bridge:', error);
            process.exit(1);
        });
}

// Only run if this script is executed directly
if (require.main === module || (require.main && require.main.filename === __filename)) {
    main();
}

// Export classes for tests
const CBusEvent = require('./src/cbusEvent');
const CBusCommand = require('./src/cbusCommand');

module.exports = { 
    main, 
    defaultSettings, 
    CgateWebBridge, 
    CBusEvent, 
    CBusCommand, 
    settings: defaultSettings  // Alias for backward compatibility
};