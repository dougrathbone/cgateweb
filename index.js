#!/usr/bin/env node

const path = require('path');
const CgateWebBridge = require('./src/cgateWebBridge');

// --- Default Settings (can be overridden by ./settings.js) ---
const defaultSettings = {
    mqtt: 'localhost:1883',
    cbusip: '192.168.0.22',
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
    ha_discovery_enabled: false,
    ha_discovery_prefix: 'homeassistant',
    ha_discovery_networks: [],
    ha_discovery_cover_app_id: '203',
    ha_discovery_switch_app_id: null,
    ha_discovery_relay_app_id: null,
    ha_discovery_pir_app_id: null
};

// --- Load User Settings ---
let userSettings = {};
try {
    userSettings = require('./settings.js');
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        console.error('[ERROR] Configuration file ./settings.js not found. Using default settings.');
    } else {
        console.error(`[ERROR] Error loading ./settings.js: ${e.message}. Using default settings.`);
    }
}

// Merge settings
const settings = { ...defaultSettings, ...userSettings };

// Validate critical settings
function validateSettings() {
    const errors = [];
    
    if (!settings.cbusip) {
        errors.push('cbusip is required');
    }
    
    if (!settings.cbusname) {
        errors.push('cbusname is required');  
    }
    
    if (!settings.mqtt) {
        errors.push('mqtt broker address is required');
    }
    
    if (errors.length > 0) {
        console.error('[ERROR] Invalid configuration:');
        errors.forEach(error => console.error(`  - ${error}`));
        process.exit(1);
    }
}

// Application startup
function main() {
    console.log('[INFO] Starting cgateweb...');
    console.log(`[INFO] Version: ${require('./package.json').version}`);
    
    validateSettings();
    
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
    
    // Start the bridge
    bridge.start();
    
    console.log('[INFO] cgateweb started successfully');
}

// Only run if this script is executed directly
if (require.main === module) {
    main();
}

module.exports = { main, defaultSettings };