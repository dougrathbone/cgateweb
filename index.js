#!/usr/bin/env node

const CgateWebBridge = require('./src/cgateWebBridge');
const { validateWithWarnings } = require('./src/settingsValidator');
const ConfigLoader = require('./src/config/ConfigLoader');
const HAIntegration = require('./src/config/HAIntegration');
const { defaultSettings } = require('./src/defaultSettings');

// --- Initialize Home Assistant Integration ---
const haIntegration = new HAIntegration();
const haConfig = haIntegration.initialize();

// --- Load Settings using ConfigLoader ---
let settings = { ...defaultSettings };
try {
    const configLoader = new ConfigLoader();
    const loadedConfig = configLoader.load();
    settings = { ...defaultSettings, ...loadedConfig };
    
    const envInfo = configLoader.getEnvironment();
    console.log(`[INFO] Environment: ${envInfo.type}`);
    
    if (haConfig.isAddon) {
        console.log(`[INFO] Home Assistant optimizations: ${haConfig.optimizationsApplied.join(', ')}`);
        if (haConfig.ingressConfig) {
            console.log(`[INFO] Ingress configured: ${haConfig.ingressConfig.ingressUrl}`);
        }
    }
    
    const source = loadedConfig._environment ? loadedConfig._environment.type : 'unknown';
    console.log(`[INFO] Configuration loaded from: ${source}`);
} catch (error) {
    console.error(`[ERROR] Failed to load configuration: ${error.message}`);
    console.error('[ERROR] Using default settings only');
}

const envOverrides = {
    MQTT_HOST: 'mqtt',
    MQTT_USERNAME: 'mqttusername',
    MQTT_PASSWORD: 'mqttpassword',
    CGATE_IP: 'cbusip',
    CGATE_USERNAME: 'cgateusername',
    CGATE_PASSWORD: 'cgatepassword',
    CGATE_PROJECT: 'cbusname',
};

for (const [envKey, settingKey] of Object.entries(envOverrides)) {
    if (process.env[envKey] !== undefined) {
        settings[settingKey] = process.env[envKey];
    }
}


// Application startup
async function main() {
    console.log('[INFO] Starting cgateweb...');
    console.log(`[INFO] Version: ${require('./package.json').version}`);
    
    // Auto-detect MQTT credentials from Supervisor API when running as an addon
    if (process.env.SUPERVISOR_TOKEN) {
        try {
            const configLoader = new ConfigLoader();
            await configLoader.applyMqttAutoDetection(settings);
        } catch (error) {
            console.error('[WARN] MQTT auto-detection failed:', error.message);
        }
    }
    
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