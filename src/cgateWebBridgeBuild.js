// @ts-check
'use strict';

const path = require('path');
const CgateConnection = require('./cgateConnection');
const CgateConnectionPool = require('./cgateConnectionPool');
const MqttManager = require('./mqttManager');
const ThrottledQueue = require('./throttledQueue');
const MqttCommandRouter = require('./mqttCommandRouter');
const ConnectionManager = require('./connectionManager');
const EventPublisher = require('./eventPublisher');
const AirconEventHandler = require('./airconEventHandler');
const SecurityEventHandler = require('./securityEventHandler');
const MeasurementEventHandler = require('./measurementEventHandler');
const StateResyncCoordinator = require('./stateResyncCoordinator');
const CommandResponseProcessor = require('./commandResponseProcessor');
const DeviceStateManager = require('./deviceStateManager');
const LabelLoader = require('./labelLoader');
const WebServer = require('./webServer');
const HaBridgeDiagnostics = require('./haBridgeDiagnostics');
const StaleDeviceDetector = require('./staleDeviceDetector');
const { NetworkInterfaceMonitor } = require('./networkInterfaceMonitor');
const { AirconControlRegistry } = require('./airconControlRegistry');
const CniNotificationManager = require('./cniNotificationManager');
const SerialDeviceRecovery = require('./serialDeviceRecovery');
const BridgeReadiness = require('./bridgeReadiness');
const { MQTT_RETAINED_STATE_OPTIONS } = require('./constants');
const { resolveSetting } = require('./config/schema');

/**
 * Subsystem construction for CgateWebBridge. Mixed onto the prototype via
 * Object.assign in cgateWebBridge.js. Order of the private builders is
 * load-bearing — later steps read fields installed by earlier ones.
 */
class _CgateWebBridgeBuild {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto CgateWebBridge (see Object.assign).

    /** @type {Object} */
    settings;

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {() => *} */
    _getHaDiscovery;

    /** @type {() => *} */
    _createLineProcessor;

    /** @type {() => number} */
    _getAdaptiveQueueIntervalMs;

    /** @type {() => boolean} */
    _canProcessCommandQueue;

    /** @type {(command: string) => void} */
    _sendCgateCommand;

    /** @type {(networkId: string, reading: *) => void} */
    _handleNetworkInterfaceReading;

    /** @type {(networkId: string) => void} */
    _handleNetworkSyncComplete;

    /** @type {() => Object} */
    _getBridgeStatus;

    /** @type {*|null|undefined} */
    initializationService;

    /** @type {*} */
    mqttManager;

    /** @type {*} */
    cgateCommandQueue;

    /** @type {*} */
    deviceStateManager;

    /** @type {*} */
    airconControlRegistry;

    /** @type {*} */
    mqttCommandRouter;

    /** @type {*} */
    eventPublisher;

    /** @type {*} */
    labelLoader;

    /** @type {*} */
    networkInterfaceMonitor;

    /** @type {*} */
    _mqttOptions;

    /** @type {*} */
    _onEventLog;

    /** @type {*} */
    eventStream;

    /**
     * Builds all bridge subsystems in dependency order.
     * @private
     */
    _buildSubsystems() {
        this._buildConnections();
        this._buildCommandRouting();
        this._buildLabelsAndPublisher();
        this._buildDomainEventHandlers();
        this._buildNetworkMonitoring();
        this._buildCommandResponseProcessor();
        this._buildWebAndDiagnostics();
    }

    /**
     * MQTT manager, C-Gate command pool, event connection, and connection manager.
     * @private
     */
    _buildConnections() {
        this.mqttManager = new MqttManager(this.settings);

        // Use connection pool for commands (performance optimization)
        // Event connection remains singular due to its broadcast nature
        this.commandConnectionPool = new CgateConnectionPool('command', this.settings.cbusip, this.settings.cbuscommandport, this.settings);
        this.eventConnection = new CgateConnection('event', this.settings.cbusip, this.settings.cbuseventport, this.settings);

        // Maintain backward compatibility - expose first connection from pool
        this.commandConnection = null; // Will be set after pool starts

        this.connectionManager = new ConnectionManager({
            mqttManager: this.mqttManager,
            commandConnectionPool: this.commandConnectionPool,
            eventConnection: this.eventConnection
        }, this.settings);

        // Service modules (haDiscovery will be initialized after pool starts)
        this.haDiscovery = null;
    }

    /**
     * Command queue, device state, MQTT command router, line processors, and
     * post-sync / readiness bookkeeping.
     * @private
     */
    _buildCommandRouting() {
        this._buildQueues();

        this.deviceStateManager = new DeviceStateManager({
            settings: this.settings,
            logger: this.logger
        });

        // Tracks per-thermostat ward/zone/type state for native HVAC write control.
        this.airconControlRegistry = new AirconControlRegistry();

        this.mqttCommandRouter = new MqttCommandRouter({
            cbusname: this.settings.cbusname,
            ha_discovery_enabled: this.settings.ha_discovery_enabled,
            internalEventEmitter: this.deviceStateManager.getEventEmitter(),
            cgateCommandQueue: this.cgateCommandQueue,
            deviceStateManager: this.deviceStateManager,
            mqttClient: { publish: (topic, payload, opts) => this.mqttManager.publish(topic, payload, opts) },
            settings: this.settings,
            airconControlRegistry: this.airconControlRegistry
        });

        // Per-connection line processors to prevent data interleaving across pool connections.
        // Each TCP connection gets its own processor so partial reads on one connection
        // don't corrupt lines being assembled on another.
        this.commandLineProcessors = new Map();
        this.eventLineProcessor = this._createLineProcessor();
        // Networks discovered by the init service (via auto-discovery). Read live
        // by the init service and by _resolveGetallNetworks; starts unset.
        this.discoveredNetworks = null;

        // Post-sync (762) bookkeeping per network: when the last refresh ran,
        // when the current burst of notifications started, how many distinct
        // syncs have been reported since the last refresh, and the deferred-run
        // timer. See _handleNetworkSyncComplete.
        /** @type {Map<string, {lastRunAt: number, burstStartedAt: number, syncs: number, deferHandle: (NodeJS.Timeout|null)}>} */
        this._networkSyncState = new Map();

        // Owns lifecycle state + readiness reason; emits 'readinessChanged' which
        // the bridge subscribes to (after haBridgeDiagnostics is built) to drive
        // the hello/cgateweb status publish and diagnostics refresh.
        this.bridgeReadiness = new BridgeReadiness();

        this._mqttOptions = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };
    }

    /**
     * Label loader, event-log buffer, and EventPublisher.
     * @private
     */
    _buildLabelsAndPublisher() {
        // Label loader for custom device names (before EventPublisher so it can use type overrides)
        this.labelLoader = new LabelLoader(resolveSetting(this.settings, 'cbus_label_file'), this.settings);
        this.labelLoader.load();

        // In-memory ring buffer and fan-out for live event log streaming (SSE)
        this._buildEventLogBuffer();

        // Event publisher for MQTT messages -- publishes directly without throttling.
        // MQTT QoS 0 publishes are near-instant TCP buffer writes; the mqtt library
        // handles its own buffering and flow control.
        this.eventPublisher = new EventPublisher({
            settings: this.settings,
            publishFn: (topic, payload, options) => this.mqttManager.publish(topic, payload, options),
            mqttOptions: this._mqttOptions,
            labelLoader: this.labelLoader,
            logger: this.logger,
            coverRampTracker: this.mqttCommandRouter.coverRampTracker,
            onEventLog: this._onEventLog
        });
    }

    /**
     * Aircon, security, and measurement event handlers plus state resync.
     * @private
     */
    _buildDomainEventHandlers() {
        // Decodes native-aircon (app 172) event lines, records control state, and
        // publishes readings. haDiscovery is read live as it's initialized later.
        // sendCommand feeds the throttled command queue (AIRCON REFRESH only,
        // and only when control is enabled — see _maybeRefreshWard).
        this.airconEventHandler = new AirconEventHandler({
            registry: this.airconControlRegistry,
            eventPublisher: this.eventPublisher,
            logger: this.logger,
            settings: this.settings,
            getHaDiscovery: this._getHaDiscovery,
            cbusname: this.settings.cbusname,
            sendCommand: (command) => this.cgateCommandQueue.add(command)
        });

        // Decodes security (app 208) event lines and publishes zone state.
        // sendCommand feeds the throttled command queue (security
        // status_request initial sync; arm/disarm writes are MQTT-routed).
        this.securityEventHandler = new SecurityEventHandler({
            eventPublisher: this.eventPublisher,
            logger: this.logger,
            settings: this.settings,
            getHaDiscovery: this._getHaDiscovery,
            cbusname: this.settings.cbusname,
            sendCommand: (command) => this.cgateCommandQueue.add(command),
            onEventLog: this._onEventLog,
            // Panel trouble state survives restarts via a small JSON file next
            // to the label file; no label file means no writable path is
            // known, so persistence stays off.
            panelStateFile: this.settings.cbus_label_file
                ? path.join(path.dirname(this.settings.cbus_label_file), 'security-panel-state.json')
                : null
        });

        // Decodes native-measurement (app 228) event lines and publishes
        // readings. Purely event-driven — the spec (§28.9) says measurement
        // devices never respond to status requests, so there's no initial sync.
        this.measurementEventHandler = new MeasurementEventHandler({
            eventPublisher: this.eventPublisher,
            logger: this.logger,
            settings: this.settings,
            getHaDiscovery: this._getHaDiscovery
        });

        // Republishes state after a Home Assistant or MQTT broker restart
        // (issue #44). Neither event restarts the bridge, so nothing else would.
        this.stateResyncCoordinator = new StateResyncCoordinator({
            settings: this.settings,
            logger: this.logger,
            getHaDiscovery: this._getHaDiscovery,
            // Late-bound: initializationService is assigned after
            // _buildSubsystems returns, so it must be read live, not captured.
            getInitializationService: () => this.initializationService
        });
    }

    /**
     * CNI/PCI monitor, serial recovery, and CNI notification manager.
     * @private
     */
    _buildNetworkMonitoring() {
        this.networkInterfaceMonitor = new NetworkInterfaceMonitor({ logger: this.logger });

        // Recovers a USB PC Interface that renumbered while running (issue #28).
        // Inert unless managed mode has a cgate_serial_device configured, so CNI
        // installs never see it.
        this.serialDeviceRecovery = new SerialDeviceRecovery({
            settings: this.settings,
            logger: this.logger
        });

        // CNI online/offline state machine: publishes connectivity state and
        // raises/dismisses HA persistent notifications on transitions.
        this.cniNotificationManager = new CniNotificationManager({
            networkInterfaceMonitor: this.networkInterfaceMonitor,
            mqttManager: this.mqttManager,
            getHaDiscovery: this._getHaDiscovery,
            logger: this.logger,
            settings: this.settings,
            mqttOptions: this._mqttOptions,
            serialDeviceRecovery: this.serialDeviceRecovery
        });
    }

    /**
     * Command-response processor (depends on publisher + network monitor).
     * @private
     */
    _buildCommandResponseProcessor() {
        this.commandResponseProcessor = new CommandResponseProcessor({
            eventPublisher: this.eventPublisher,
            haDiscovery: null, // Will be set after haDiscovery is initialized
            onObjectStatus: (event) => this.deviceStateManager.updateLevelFromEvent(event),
            onNetworkState: (networkId, reading) => this._handleNetworkInterfaceReading(networkId, reading),
            onNetworkSyncComplete: (networkId) => this._handleNetworkSyncComplete(networkId),
            getNetworkInterfaceState: (networkId) => this.networkInterfaceMonitor.getNetwork(networkId),
            maxPendingTreeMessages: resolveSetting(this.settings, 'commandResponseMaxPendingTreeMessages'),
            errorRepeatWindowMs: resolveSetting(this.settings, 'commandErrorRepeatWindowMs'),
            logger: this.logger
        });
    }

    /**
     * Web UI server, HA bridge diagnostics, and stale-device detector.
     * @private
     */
    _buildWebAndDiagnostics() {
        // Web server for label editing UI. In add-on mode nothing injects
        // INGRESS_ENTRY, so the ingress base path is discovered from the
        // Supervisor API after startup (see _discoverIngressBasePath);
        // INGRESS_ENTRY remains an explicit override when set.
        const ingressBasePath = process.env.INGRESS_ENTRY || '';
        this.webServer = new WebServer(/** @type {any} */ ({
            port: resolveSetting(this.settings, 'web_port'),
            bindHost: resolveSetting(this.settings, 'web_bind_host'),
            basePath: ingressBasePath,
            labelLoader: this.labelLoader,
            apiKey: resolveSetting(this.settings, 'web_api_key'),
            allowUnauthenticatedMutations: resolveSetting(this.settings, 'web_allow_unauthenticated_mutations') === true,
            allowedOrigins: resolveSetting(this.settings, 'web_allowed_origins'),
            maxMutationRequestsPerWindow: resolveSetting(this.settings, 'web_mutation_rate_limit_per_minute'),
            maxReadRequestsPerWindow: resolveSetting(this.settings, 'web_read_rate_limit_per_minute'),
            maxAuthFailuresPerWindow: resolveSetting(this.settings, 'web_auth_failure_rate_limit_per_minute'),
            rateLimitWindowMs: resolveSetting(this.settings, 'webRateLimitWindowMs'),
            maxBodySizeBytes: resolveSetting(this.settings, 'webMaxBodySizeBytes'),
            activeDeviceWindowMs: resolveSetting(this.settings, 'web_active_device_window_ms'),
            haAreasCacheTtlMs: resolveSetting(this.settings, 'web_ha_areas_cache_ttl_ms'),
            haApiTimeoutMs: resolveSetting(this.settings, 'web_ha_api_timeout_ms'),
            maxDashboardDevices: resolveSetting(this.settings, 'webDashboardMaxDevices'),
            maxSseConnections: resolveSetting(this.settings, 'web_max_sse_connections'),
            _sseKeepaliveMs: resolveSetting(this.settings, 'webSseKeepaliveMs'),
            triggerAppId: resolveSetting(this.settings, 'ha_discovery_trigger_app_id'),
            getStatus: () => this._getBridgeStatus(),
            deviceStateManager: this.deviceStateManager,
            eventStream: this.eventStream
        }));
        this.haBridgeDiagnostics = new HaBridgeDiagnostics(
            this.settings,
            (topic, payload, options) => this.mqttManager.publish(topic, payload, options),
            () => this._getBridgeStatus(),
            this.logger
        );
        this.staleDeviceDetector = new StaleDeviceDetector({
            deviceStateManager: this.deviceStateManager,
            mqttClient: { publish: (topic, payload, opts) => this.mqttManager.publish(topic, payload, opts) },
            settings: this.settings,
            labelLoader: this.labelLoader,
            logger: this.logger
        });
    }

    /**
     * Builds the throttled C-Gate command queue. Depends on mqttManager (for the
     * onDrop warning publish) and on the _getAdaptiveQueueIntervalMs /
     * _canProcessCommandQueue methods (available as instance methods).
     * @private
     */
    _buildQueues() {
        const queueOptions = {
            maxSize: resolveSetting(this.settings, 'maxQueueSize'),
            getIntervalMs: () => this._getAdaptiveQueueIntervalMs(),
            canProcessFn: () => this._canProcessCommandQueue(),
            retryWhenBlockedMinMs: resolveSetting(this.settings, 'queueRetryWhenBlockedMinMs'),
            retryWhenBlockedCapMs: resolveSetting(this.settings, 'queueRetryWhenBlockedCapMs'),
            onDrop: (droppedCount, priority, maxSize) => {
                this.mqttManager.publish(
                    'hello/cgateweb/warnings',
                    `C-Gate command queue full (max ${maxSize}), ${droppedCount} command(s) dropped`,
                    { retain: false }
                );
            }
        };
        this.cgateCommandQueue = new ThrottledQueue(
            (command) => this._sendCgateCommand(command),
            resolveSetting(this.settings, 'messageinterval'),
            'C-Gate Command Queue',
            queueOptions
        );
    }

    /**
     * Sets up the in-memory ring buffer and fan-out used for live event log
     * streaming (SSE). Establishes _eventLogBuffer, _eventLogListeners,
     * _onEventLog and the eventStream interface consumed by the web server.
     * @private
     */
    _buildEventLogBuffer() {
        const eventLogMax = Math.max(10, resolveSetting(this.settings, 'eventLogMaxEntries'));
        // Circular buffer with a head index: once full, overwriting the oldest
        // slot is O(1) where Array.shift() was O(n) per event. The array is
        // only materialized (in order) by getRecent.
        this._eventLogSize = eventLogMax;
        this._eventLogBuffer = new Array(eventLogMax);
        this._eventLogHead = 0;  // slot holding the oldest entry
        this._eventLogCount = 0; // entries stored (≤ _eventLogSize)
        this._eventLogListeners = new Set();
        this._onEventLog = (entry) => {
            if (this._eventLogCount < this._eventLogSize) {
                this._eventLogBuffer[(this._eventLogHead + this._eventLogCount) % this._eventLogSize] = entry;
                this._eventLogCount++;
            } else {
                this._eventLogBuffer[this._eventLogHead] = entry;
                this._eventLogHead = (this._eventLogHead + 1) % this._eventLogSize;
            }
            for (const fn of this._eventLogListeners) {
                try { fn(entry); } catch (e) { this.logger.debug('Event-log listener threw', { error: e }); }
            }
        };

        // eventStream interface for WebServer SSE endpoint
        this.eventStream = {
            subscribe: (fn) => { this._eventLogListeners.add(fn); },
            unsubscribe: (fn) => { this._eventLogListeners.delete(fn); },
            getRecent: () => {
                const recent = new Array(this._eventLogCount);
                for (let i = 0; i < this._eventLogCount; i++) {
                    recent[i] = this._eventLogBuffer[(this._eventLogHead + i) % this._eventLogSize];
                }
                return recent;
            }
        };
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_CgateWebBridgeBuild.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _CgateWebBridgeBuild.prototype[name];
}
module.exports = methods;
