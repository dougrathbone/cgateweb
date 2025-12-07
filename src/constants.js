const packageJson = require('../package.json');

// === Logging ===
const LOG_PREFIX = '[INFO]';
const WARN_PREFIX = '[WARN]';
const ERROR_PREFIX = '[ERROR]';

// === C-Bus System ===
const DEFAULT_CBUS_APP_LIGHTING = '56';  // C-Bus application ID for lighting devices
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

// === MQTT System ===
const MQTT_TOPIC_PREFIX_CBUS = 'cbus';
const MQTT_TOPIC_PREFIX_READ = `${MQTT_TOPIC_PREFIX_CBUS}/read`;
const MQTT_TOPIC_PREFIX_WRITE = `${MQTT_TOPIC_PREFIX_CBUS}/write`;
const MQTT_TOPIC_SUFFIX_STATE = 'state';
const MQTT_TOPIC_SUFFIX_LEVEL = 'level';
const MQTT_TOPIC_SUFFIX_POSITION = 'position';  // Cover position (0-100%)
const MQTT_TOPIC_SUFFIX_TREE = 'tree';
const MQTT_TOPIC_STATUS = 'hello/cgateweb';
const MQTT_TOPIC_MANUAL_TRIGGER = `${MQTT_TOPIC_PREFIX_WRITE}/bridge/announce`;

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
const MQTT_CMD_TYPE_STOP = 'stop';          // Stop cover movement

// === Home Assistant Discovery ===
const HA_COMPONENT_LIGHT = 'light';
const HA_COMPONENT_COVER = 'cover';
const HA_COMPONENT_SWITCH = 'switch';
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

// HA Origin Info
const HA_ORIGIN_NAME = 'cgateweb';
const HA_ORIGIN_SW_VERSION = packageJson.version;
const HA_ORIGIN_SUPPORT_URL = 'https://github.com/dougrathbone/cgateweb';

// === System ===
const NEWLINE = '\n';

// === Parsing Patterns ===
const EVENT_REGEX = /^(\w+)\s+(\w+)\s+(?:(?:\/\/\w+\/)?(\d+\/\d+\/\d+))(?:\s+(\d+))?/;
const COMMAND_TOPIC_REGEX = /^cbus\/write\/(\w*)\/(\w*)\/(\w*)\/(\w+)/;

// Export all constants - maintain compatibility with destructuring imports
module.exports = {
    // Logging
    LOG_PREFIX,
    WARN_PREFIX,
    ERROR_PREFIX,
    
    // C-Bus System  
    DEFAULT_CBUS_APP_LIGHTING,
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
    
    // MQTT System
    MQTT_TOPIC_PREFIX_CBUS,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TREE,
    MQTT_TOPIC_STATUS,
    MQTT_TOPIC_MANUAL_TRIGGER,
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
    MQTT_CMD_TYPE_STOP,
    
    // Home Assistant Discovery
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_COVER,
    HA_COMPONENT_SWITCH,
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
    HA_ORIGIN_NAME,
    HA_ORIGIN_SW_VERSION,
    HA_ORIGIN_SUPPORT_URL,
    
    // System
    NEWLINE,
    EVENT_REGEX,
    COMMAND_TOPIC_REGEX
};