
//cbus ip address
exports.cbusip = '127.0.0.1';


//cbus project name
exports.cbusname = "HOME";

//mqtt server ip:port
exports.mqtt = '127.0.0.1:1883';

//username and password (uncomment to use)
//exports.mqttusername = 'user1';
//exports.mqttpassword = 'password1';

// --- MQTT TLS Settings ---
// Use TLS when connecting with host:port format (mqtts:// URLs enable TLS automatically)
// exports.mqttUseTls = true;
// Path to CA certificate file (PEM format)
// exports.mqttCaFile = '/path/to/ca.crt';
// Path to client certificate file (PEM format, for mutual TLS)
// exports.mqttCertFile = '/path/to/client.crt';
// Path to client private key file (PEM format, for mutual TLS)
// exports.mqttKeyFile = '/path/to/client.key';
// Set to false to skip server certificate verification (not recommended for production)
// exports.mqttRejectUnauthorized = false;

// net and app for automatically requesting values
// exports.getallnetapp = '254/56';

// whether to request on start (requires getallnetapp set as well)
// exports.getallonstart = true;

// how often to request after start (in seconds), (requires getallnetapp set as well)
// exports.getallperiod = 60*60;

// Sets MQTT retain flag for values coming from cgate
// exports.retainreads = true;

exports.messageinterval = 200;

//logging
exports.logging = false;

// --- Home Assistant MQTT Discovery Settings ---
// Enable/disable HA discovery
// exports.ha_discovery_enabled = true;

// MQTT prefix HA uses for discovery (usually 'homeassistant')
// exports.ha_discovery_prefix = 'homeassistant';

// C-Bus network IDs to scan for devices during discovery
// e.g., [254] or [254, 255]
// If empty and getallnetapp is set, will attempt to use network from getallnetapp
// exports.ha_discovery_networks = [254]; 

// C-Bus Application ID to treat as Covers (e.g., 203 for Enable Control)
// exports.ha_discovery_cover_app_id = '203';

// C-Bus Application ID to treat as Switches (e.g., 203 for Enable Control or 1 for Relay)
// Set to a string/number ID to enable switch discovery for that App.
// exports.ha_discovery_switch_app_id = null; 
