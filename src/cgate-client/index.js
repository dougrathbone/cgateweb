// @ts-check
'use strict';

/*
 * cgate-client — the reusable C-Gate / C-Bus protocol surface of cgateweb.
 *
 * WHAT THIS IS
 * A re-export barrel, nothing more. Every symbol below already lives in an
 * existing module under src/; this file moves no code and changes no
 * behaviour. Its only job is to give an external consumer one stable import
 * path for the transport and protocol layer, so that consumer can track this
 * repo instead of vendoring copies of individual files. The sibling
 * cgate-studio Electron app currently vendors cgateConnection.js,
 * constants.js, logger.js, backoff.js and cbusEvent.js verbatim from an old
 * tag; those copies have already drifted by dozens of commits and are missing
 * fixes. This barrel is the first step in replacing that vendoring with a
 * dependency.
 *
 * IMPORT PURITY IS THE CONTRACT
 * Requiring this file MUST NOT read configuration, touch the filesystem
 * looking for settings, probe the current working directory, write to stdout
 * or stderr, or register timers, sockets or process handlers. A consumer
 * embedding the protocol layer must not inherit cgateweb's config loading and
 * startup logging just by importing it — that is exactly what makes the
 * difference between a library and an application entry point. Only modules
 * verified side-effect-free at require time are re-exported here, and
 * tests/cgateClientBarrel.test.js enforces the rule from a child process with
 * a working directory that contains no settings.js.
 *
 * The heavier project-file parser (adm-zip / sql.js / xml2js) is deliberately
 * NOT here — it lives in ./project so those dependencies never load on the
 * transport path. See that file.
 *
 * LONG TERM
 * The intent is to extract this into a real published `cgate-client` package.
 * Until then, treat the export list below as the public API: renaming or
 * removing an entry is a breaking change for consumers, and a rename in an
 * underlying module that silently empties this barrel is caught by the export
 * resolution test.
 *
 * KNOWN WART (deliberately not fixed here)
 * src/constants.js mixes C-Gate protocol constants with MQTT topic strings and
 * Home Assistant discovery vocabulary, and it does `require('../package.json')`
 * at load time to stamp a version into the HA origin block. Splitting it is a
 * later step. For now this barrel re-exports only the protocol-relevant subset
 * by name, so consumers do not take a dependency on cgateweb's MQTT or Home
 * Assistant vocabulary.
 */

const { backoffDelay } = require('../backoff');
const { LineProcessor } = require('../lineProcessor');
const CgateConnection = require('../cgateConnection');
const CgateConnectionPool = require('../cgateConnectionPool');
const CBusEvent = require('../cbusEvent');
const ThrottledQueue = require('../throttledQueue');
const { Logger, createLogger } = require('../logger');

const applicationDecoders = require('../applicationDecoders');
const appEventLine = require('../applicationDecoders/appEventLine');
const temperatureDecoder = require('../applicationDecoders/temperatureDecoder');
const airconDecoder = require('../applicationDecoders/airconDecoder');
const measurementDecoder = require('../applicationDecoders/measurementDecoder');
const securityDecoder = require('../applicationDecoders/securityDecoder');

const {
    buildSecurityStatusRequest,
    buildSecurityArmCommand,
    buildSecurityEmulateKeypadCommand
} = require('../securityCommand');
const { buildMeasurementDataCommand } = require('../measurementCommand');
const SecurityPanelState = require('../securityPanelState');
const securityPanelConditions = require('../securityPanelConditions');
const {
    securityZoneLabelKey,
    parseSecurityZoneLabelKey
} = require('../securityZoneLabels');

const constants = require('../constants');

/**
 * C-Gate / C-Bus protocol constants only. MQTT topic strings, Home Assistant
 * discovery vocabulary and add-on file paths are intentionally excluded — they
 * are cgateweb's bindings, not the protocol.
 */
const protocolConstants = Object.freeze({
    // C-Bus application ids
    DEFAULT_CBUS_APP_LIGHTING: constants.DEFAULT_CBUS_APP_LIGHTING,
    DEFAULT_CBUS_APP_TEMPERATURE: constants.DEFAULT_CBUS_APP_TEMPERATURE,
    DEFAULT_CBUS_APP_AIRCON: constants.DEFAULT_CBUS_APP_AIRCON,
    DEFAULT_CBUS_APP_SECURITY: constants.DEFAULT_CBUS_APP_SECURITY,
    DEFAULT_CBUS_APP_MEASUREMENT: constants.DEFAULT_CBUS_APP_MEASUREMENT,
    DEFAULT_CBUS_APP_CLOCK: constants.DEFAULT_CBUS_APP_CLOCK,

    // C-Bus level range
    CGATE_LEVEL_MIN: constants.CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX: constants.CGATE_LEVEL_MAX,
    RAMP_STEP: constants.RAMP_STEP,

    // C-Gate commands
    CGATE_CMD_ON: constants.CGATE_CMD_ON,
    CGATE_CMD_OFF: constants.CGATE_CMD_OFF,
    CGATE_CMD_RAMP: constants.CGATE_CMD_RAMP,
    CGATE_CMD_TERMINATERAMP: constants.CGATE_CMD_TERMINATERAMP,
    CGATE_CMD_GET: constants.CGATE_CMD_GET,
    CGATE_CMD_TREEXML: constants.CGATE_CMD_TREEXML,
    CGATE_CMD_EVENT_MODE_L6: constants.CGATE_CMD_EVENT_MODE_L6,
    CGATE_CMD_LOGIN: constants.CGATE_CMD_LOGIN,
    CGATE_PARAM_LEVEL: constants.CGATE_PARAM_LEVEL,

    // C-Gate response codes
    CGATE_RESPONSE_OBJECT_STATUS: constants.CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START: constants.CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_END: constants.CGATE_RESPONSE_TREE_END,
    CGATE_RESPONSE_TREE_DATA: constants.CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_SYSTEM_EVENT: constants.CGATE_RESPONSE_SYSTEM_EVENT,
    CGATE_RESPONSE_NETWORK_SYNC_OK: constants.CGATE_RESPONSE_NETWORK_SYNC_OK,

    // Wire format / parsing
    NEWLINE: constants.NEWLINE,
    EVENT_REGEX: constants.EVENT_REGEX,
    CGATE_EVENT_NETWORK_SYNC_REGEX: constants.CGATE_EVENT_NETWORK_SYNC_REGEX
});

module.exports = {
    // Transport
    CgateConnection,
    CgateConnectionPool,
    LineProcessor,
    ThrottledQueue,
    backoffDelay,

    // Logging (injectable; writes nothing until called)
    Logger,
    createLogger,

    // Event parsing
    CBusEvent,

    // Application decoders
    getDecoder: applicationDecoders.getDecoder,
    appEventLine,
    temperatureDecoder,
    airconDecoder,
    measurementDecoder,
    securityDecoder,

    // Command builders
    buildSecurityStatusRequest,
    buildSecurityArmCommand,
    buildSecurityEmulateKeypadCommand,
    buildMeasurementDataCommand,

    // Security domain model
    SecurityPanelState,
    securityPanelConditions,
    securityZoneLabelKey,
    parseSecurityZoneLabelKey,

    // Protocol constants
    constants: protocolConstants
};
