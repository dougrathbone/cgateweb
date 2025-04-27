//cbus ip address
exports.cbusip = '127.0.0.1';


//cbus project name
exports.cbusname = "HOME";

// --- C-Gate Connection Settings ---
exports.cbuscommandport = 20023; // C-Gate command port (default 20023)
exports.cbuseventport = 20025;   // C-Gate event port (usually Status Change Port 20025)

// --- C-Gate SSL/TLS (EXPERIMENTAL) ---
// NOTE: C-Gate is known to use older TLS versions (potentially only TLS 1.0).
// Enabling SSL may not work with modern Node.js versions or may require
// specific Node.js configurations or C-Gate updates.
// Use with caution and test thoroughly in your environment.
// Enable SSL/TLS for C-Gate connections (requires C-Gate SSL ports enabled)
// exports.cgate_ssl_enabled = true;
// exports.cbuscommandport_ssl = 20123; // C-Gate command port SSL (default 20123)
// exports.cbuseventport_ssl = 20125;   // C-Gate event port SSL (default 20125)

// Optional TLS options (passed directly to Node.js tls.connect)
// Useful for self-signed certificates, etc.
// See: https://nodejs.org/api/tls.html#tlsconnectoptions-callback
// Example: Allow self-signed certs (UNSECURE! Use only if necessary)
// exports.cgate_ssl_options = {
//   rejectUnauthorized: false
// };

//mqtt server ip:port
exports.mqtt = '127.0.0.1:1883';

//username and password (unncomment to use)
//exports.mqttusername = 'user1';
//exports.mqttpassword = 'password1';

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
