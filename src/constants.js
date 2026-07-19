// @ts-check
const packageJson = require('../package.json');

// === C-Bus System ===
const DEFAULT_CBUS_APP_LIGHTING = '56';  // C-Bus application ID for lighting devices
const DEFAULT_CBUS_APP_TRIGGER = '202'; // C-Bus application ID for trigger groups (keypads, scenes)
const DEFAULT_CBUS_APP_TEMPERATURE = '25';   // C-Bus Temperature Broadcast application ($19)
const DEFAULT_CBUS_APP_MEASUREMENT = '228';  // C-Bus Measurement application ($E4)
const DEFAULT_CBUS_APP_AIRCON = '172';       // C-Bus Air Conditioning application ($AC)
const CGATE_LEVEL_MIN = 0;               // C-Bus minimum brightness level (off)
const CGATE_LEVEL_MAX = 255;             // C-Bus maximum brightness level (full brightness)
const RAMP_STEP = 26; // 10% of 255, made explicit instead of calculation

// C-Gate Commands
const CGATE_CMD_ON = 'ON';
const CGATE_CMD_OFF = 'OFF';
const CGATE_CMD_RAMP = 'RAMP';
const CGATE_CMD_TERMINATERAMP = 'TERMINATERAMP';  // Stop an in-progress ramp operation
const CGATE_CMD_GET = 'GET';
const CGATE_CMD_TREEXML = 'TREEXML';
const CGATE_CMD_EVENT_ON = 'EVENT ON';
const CGATE_CMD_LOGIN = 'LOGIN';
const CGATE_PARAM_LEVEL = 'level';

// C-Gate Response Codes (similar to HTTP status codes)
const CGATE_RESPONSE_OBJECT_STATUS = '300';  // Device status response (e.g., "300 //PROJECT/254/56/1: level=255")
const CGATE_RESPONSE_TREE_START = '343';     // Start of TREEXML response
const CGATE_RESPONSE_TREE_END = '344';       // End of TREEXML response
const CGATE_RESPONSE_TREE_DATA = '347';      // TREEXML data line
const CGATE_RESPONSE_SYSTEM_EVENT = '742';   // Async object/network event (e.g. "Network created")
const CGATE_RESPONSE_NETWORK_SYNC_OK = '762'; // Async "Network sync ok" event — network finished synchronising

// === MQTT System ===
const MQTT_TOPIC_PREFIX_CBUS = 'cbus';
const MQTT_TOPIC_PREFIX_READ = `${MQTT_TOPIC_PREFIX_CBUS}/read`;
const MQTT_TOPIC_PREFIX_WRITE = `${MQTT_TOPIC_PREFIX_CBUS}/write`;
const MQTT_TOPIC_SUFFIX_STATE = 'state';
const MQTT_TOPIC_SUFFIX_LEVEL = 'level';
const MQTT_TOPIC_SUFFIX_POSITION = 'position';  // Cover position (0-100%)
const MQTT_TOPIC_SUFFIX_TILT = 'tilt';          // Cover tilt angle (0-100%)
const MQTT_TOPIC_SUFFIX_EVENT = 'event';        // Trigger group event
const MQTT_TOPIC_SUFFIX_TREE = 'tree';
// HVAC topic suffixes
const MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP = 'current_temperature'; // Current temperature reading
const MQTT_TOPIC_SUFFIX_HVAC_SETPOINT = 'setpoint';                // Target temperature setpoint
const MQTT_TOPIC_SUFFIX_HVAC_MODE = 'mode';                        // HVAC operating mode
const MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE = 'fan_mode';               // Fan mode (automatic/continuous, Aux Level bit 6)
const MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED = 'fan_speed';             // Raw fan speed setting (0-63, Aux Level bits 0-5)
const MQTT_TOPIC_SUFFIX_HVAC_ACTION = 'action';                   // Current running action (heating/cooling/fan/idle)
const MQTT_TOPIC_SUFFIX_HVAC_ERROR = 'error';                     // HVAC plant error code (0 = no error, spec §25.6.5)
const MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION = 'error_description'; // Human-readable HVAC plant error
const MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS = 'sensor_status';     // Temp sensor status (spec §25.6.12, 0 = ok)
// Settable temperature range for native C-Bus HVAC thermostats (e.g. 5070TH).
// HA's climate card and our write clamp both use this so users can't request a
// value the thermostat will silently reject.
const HVAC_MIN_TEMP_C = 10;
const HVAC_MAX_TEMP_C = 32;
const MQTT_TOPIC_STATUS = 'hello/cgateweb';
const MQTT_TOPIC_MANUAL_TRIGGER = `${MQTT_TOPIC_PREFIX_WRITE}/bridge/announce`;

// Default publish options for retained state topics (HA Discovery configs,
// device states, diagnostics). Frozen so callers can't accidentally mutate
// the shared object.
const MQTT_RETAINED_STATE_OPTIONS = Object.freeze({ retain: true, qos: 0 });

// MQTT Payloads
const MQTT_PAYLOAD_STATUS_ONLINE = 'Online';
const MQTT_PAYLOAD_STATUS_OFFLINE = 'Offline';
const MQTT_STATE_ON = 'ON';
const MQTT_STATE_OFF = 'OFF';
const MQTT_COMMAND_INCREASE = 'INCREASE';
const MQTT_COMMAND_DECREASE = 'DECREASE';
const MQTT_COMMAND_STOP = 'STOP';  // Stop cover movement or ramp operation
const MQTT_ERROR_AUTH = 5;

// MQTT Command Types
const MQTT_CMD_TYPE_GETALL = 'getall';
const MQTT_CMD_TYPE_GETTREE = 'gettree';
const MQTT_CMD_TYPE_SWITCH = 'switch';
const MQTT_CMD_TYPE_RAMP = 'ramp';
const MQTT_CMD_TYPE_POSITION = 'position';  // Set cover position (0-100%)
const MQTT_CMD_TYPE_TILT = 'tilt';          // Set cover tilt angle (0-100%)
const MQTT_CMD_TYPE_STOP = 'stop';          // Stop cover movement
const MQTT_CMD_TYPE_TRIGGER = 'trigger';          // Fire a C-Bus trigger group
const MQTT_CMD_TYPE_HVAC_SETPOINT = 'setpoint';  // Set HVAC target temperature
const MQTT_CMD_TYPE_HVAC_MODE = 'hvacmode';      // Set HVAC operating mode

// === Home Assistant Discovery ===
const HA_COMPONENT_LIGHT = 'light';
const HA_COMPONENT_COVER = 'cover';
const HA_COMPONENT_SWITCH = 'switch';
const HA_COMPONENT_BUTTON = 'button';
const HA_COMPONENT_CLIMATE = 'climate';
const HA_COMPONENT_SENSOR = 'sensor';
const HA_COMPONENT_BINARY_SENSOR = 'binary_sensor';
const HA_DISCOVERY_SUFFIX = 'config';

// HA Device Classes
const HA_DEVICE_CLASS_SHUTTER = 'shutter';
const HA_DEVICE_CLASS_OUTLET = 'outlet';

// HA Device Info
const HA_DEVICE_VIA = 'cgateweb_bridge';
const HA_DEVICE_MANUFACTURER = 'Clipsal C-Bus via cgateweb';
const HA_MODEL_LIGHTING = 'Lighting Group';
const HA_MODEL_COVER = 'Enable Control Group (Cover)';
const HA_MODEL_SWITCH = 'Enable Control Group (Switch)';
const HA_MODEL_RELAY = 'Enable Control Group (Relay)';
const HA_MODEL_PIR = 'PIR Motion Sensor';
const HA_MODEL_TRIGGER = 'Trigger Group';
const HA_MODEL_HVAC = 'HVAC Zone (Air Conditioning)';
const HA_COMPONENT_EVENT = 'event';
const HA_COMPONENT_SCENE = 'scene';

// HA Discovery health states surfaced as the per-network "Discovery" sensor.
const DISCOVERY_STATE_DISCOVERING = 'discovering';
const DISCOVERY_STATE_OK = 'ok';
const DISCOVERY_STATE_PAUSED = 'paused';

const MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS = 'discovery_status';

// HA Origin Info
const HA_ORIGIN_NAME = 'cgateweb';
const HA_ORIGIN_SW_VERSION = packageJson.version;
const HA_ORIGIN_SUPPORT_URL = 'https://github.com/dougrathbone/cgateweb';

// HA Discovery entity ID helpers
function entityIdFields(component, objectId) {
    return { default_entity_id: `${component}.${objectId}`, object_id: objectId };
}

// === File Paths ===
// Default label-file path for Home Assistant add-on installs — /config is mounted
// read-write and persists across updates.
const DEFAULT_ADDON_LABEL_FILE = '/config/cgateweb-labels.json';
const DEFAULT_ADDON_DATA_LABEL_FILE = '/data/labels.json';

// === System ===
const NEWLINE = '\n';

// === Parsing Patterns ===
const EVENT_REGEX = /^(\w+)\s+(\w+)\s+(?:(?:\/\/\w+\/)?(\d+\/\d+\/\d+))(?:\s+(\d+))?/;
// Address segments are digits-only (max 3) so malformed values like "254abc"
// are rejected at parse time instead of being silently truncated by parseInt.
// Empty segments stay allowed for getall/gettree forms (e.g. cbus/write/254///gettree);
// CBusCommand range-checks the numeric values (network 0-254, app/group 0-255).
const COMMAND_TOPIC_REGEX = /^cbus\/write\/(\d{0,3})\/(\d{0,3})\/(\d{0,3})\/(\w+)/;
// Event-port line announcing a network finished syncing ("762 //PROJECT/254
// Network sync ok"). The leading C-Gate timestamp is optional so the pattern
// also matches lines already stripped of it. Captures the network id.
const CGATE_EVENT_NETWORK_SYNC_REGEX = /^(?:\d{8}-\d{6}(?:\.\d+)?\s+)?762\s+\/\/[^/]+\/(\d+)\b/;

// Export all constants - maintain compatibility with destructuring imports
module.exports = {
    // C-Bus System
    DEFAULT_CBUS_APP_LIGHTING,
    DEFAULT_CBUS_APP_TRIGGER,
    DEFAULT_CBUS_APP_TEMPERATURE,
    DEFAULT_CBUS_APP_MEASUREMENT,
    DEFAULT_CBUS_APP_AIRCON,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX,
    RAMP_STEP,
    
    // C-Gate Commands
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_CMD_RAMP,
    CGATE_CMD_TERMINATERAMP,
    CGATE_CMD_GET,
    CGATE_CMD_TREEXML,
    CGATE_CMD_EVENT_ON,
    CGATE_CMD_LOGIN,
    CGATE_PARAM_LEVEL,
    
    // C-Gate Response Codes
    CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_END,
    CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_SYSTEM_EVENT,
    CGATE_RESPONSE_NETWORK_SYNC_OK,
    
    // MQTT System
    MQTT_TOPIC_PREFIX_CBUS,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_TOPIC_SUFFIX_TREE,
    MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS,
    HVAC_MIN_TEMP_C,
    HVAC_MAX_TEMP_C,
    MQTT_TOPIC_STATUS,
    MQTT_TOPIC_MANUAL_TRIGGER,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_PAYLOAD_STATUS_ONLINE,
    MQTT_PAYLOAD_STATUS_OFFLINE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_INCREASE,
    MQTT_COMMAND_DECREASE,
    MQTT_COMMAND_STOP,
    MQTT_ERROR_AUTH,
    MQTT_CMD_TYPE_GETALL,
    MQTT_CMD_TYPE_GETTREE,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_TILT,
    MQTT_CMD_TYPE_STOP,
    MQTT_CMD_TYPE_TRIGGER,
    MQTT_CMD_TYPE_HVAC_SETPOINT,
    MQTT_CMD_TYPE_HVAC_MODE,
    
    // Home Assistant Discovery
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_COVER,
    HA_COMPONENT_SWITCH,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_SENSOR,
    HA_COMPONENT_BINARY_SENSOR,
    HA_DISCOVERY_SUFFIX,
    HA_DEVICE_CLASS_SHUTTER,
    HA_DEVICE_CLASS_OUTLET,
    HA_DEVICE_VIA,
    HA_DEVICE_MANUFACTURER,
    HA_MODEL_LIGHTING,
    HA_MODEL_COVER,
    HA_MODEL_SWITCH,
    HA_MODEL_RELAY,
    HA_MODEL_PIR,
    HA_MODEL_TRIGGER,
    HA_MODEL_HVAC,
    HA_COMPONENT_EVENT,
    HA_COMPONENT_SCENE,
    DISCOVERY_STATE_DISCOVERING,
    DISCOVERY_STATE_OK,
    DISCOVERY_STATE_PAUSED,
    HA_ORIGIN_NAME,
    HA_ORIGIN_SW_VERSION,
    HA_ORIGIN_SUPPORT_URL,
    entityIdFields,

    // File Paths
    DEFAULT_ADDON_LABEL_FILE,
    DEFAULT_ADDON_DATA_LABEL_FILE,

    // System
    NEWLINE,
    EVENT_REGEX,
    COMMAND_TOPIC_REGEX,
    CGATE_EVENT_NETWORK_SYNC_REGEX
};