// @ts-check
const CgateConnection = require('./cgateConnection');
const CgateConnectionPool = require('./cgateConnectionPool');
const MqttManager = require('./mqttManager');
const BridgeInitializationService = require('./bridgeInitializationService');
const ThrottledQueue = require('./throttledQueue');
const CBusEvent = require('./cbusEvent');
const MqttCommandRouter = require('./mqttCommandRouter');
const ConnectionManager = require('./connectionManager');
const EventPublisher = require('./eventPublisher');
const AirconEventHandler = require('./airconEventHandler');
const CommandResponseProcessor = require('./commandResponseProcessor');
const DeviceStateManager = require('./deviceStateManager');
const LabelLoader = require('./labelLoader');
const WebServer = require('./webServer');
const HaBridgeDiagnostics = require('./haBridgeDiagnostics');
const StaleDeviceDetector = require('./staleDeviceDetector');
const { NetworkInterfaceMonitor } = require('./networkInterfaceMonitor');
const { AirconControlRegistry } = require('./airconControlRegistry');
const CniNotificationManager = require('./cniNotificationManager');
const BridgeReadiness = require('./bridgeReadiness');
const { discoverIngressEntry } = require('./ingressDiscovery');
const { createLogger } = require('./logger');
const { LineProcessor } = require('./lineProcessor');
const { MQTT_RETAINED_STATE_OPTIONS, CGATE_EVENT_NETWORK_SYNC_REGEX } = require('./constants');
const { clampSetting } = require('./utils');
const { parseRawCaptureTarget } = require('./rawEventCapture');

/**
 * Main bridge class that connects C-Gate (Clipsal C-Bus automation system) to MQTT.
 * 
 * This class orchestrates communication between:
 * - C-Gate server (Clipsal's C-Bus automation gateway)
 * - MQTT broker (for Home Assistant and other automation systems)
 * - Home Assistant discovery protocol
 * 
 * The bridge translates between C-Bus events and MQTT messages, enabling
 * bidirectional control of C-Bus devices through MQTT.
 * 
 * @example
 * const bridge = new CgateWebBridge({
 *   mqtt: 'mqtt://localhost:1883',
 *   cbusip: '192.168.1.100',
 *   cbuscommandport: 20023,
 *   cbuseventport: 20024,
 *   cbusname: 'SHAC'
 * });
 * bridge.start();
 */
class CgateWebBridge {
    /**
     * Creates a new CgateWebBridge instance.
     * 
     * @param {Object} settings - Configuration settings for the bridge
     * @param {string} settings.mqtt - MQTT broker URL (e.g., 'mqtt://localhost:1883')
     * @param {string} settings.cbusip - C-Gate server IP address
     * @param {number} settings.cbuscommandport - C-Gate command port (typically 20023)
     * @param {number} settings.cbuseventport - C-Gate event port (typically 20024)
     * @param {string} settings.cbusname - C-Gate project name
     * @param {Function} [mqttClientFactory=null] - Factory for creating MQTT clients (for testing)
     * @param {Function} [commandSocketFactory=null] - Factory for command sockets (for testing)
     * @param {Function} [eventSocketFactory=null] - Factory for event sockets (for testing)
     */
    constructor(settings, mqttClientFactory = null, commandSocketFactory = null, eventSocketFactory = null) {
        // Merge with default settings
        const { defaultSettings } = require('./defaultSettings');
        this.settings = { ...defaultSettings, ...settings };
        this.logger = createLogger({ 
            component: 'bridge', 
            level: this.settings.log_level || (this.settings.logging ? 'info' : 'warn'),
            enabled: true 
        });

        // Store factory references for test compatibility
        this.mqttClientFactory = mqttClientFactory;
        this.commandSocketFactory = commandSocketFactory;
        this.eventSocketFactory = eventSocketFactory;

        // Single late-binding accessor for haDiscovery, which is null at
        // construction and assigned during init. Shared by the collaborators and
        // the init service so they all read the live value, not a captured null.
        this._getHaDiscovery = () => this.haDiscovery;

        // Construct all subsystems in dependency order. _buildSubsystems invokes
        // _buildQueues and _buildEventLogBuffer inline at the exact points they
        // are needed, so construction order is identical to the original
        // inline constructor.
        this._buildSubsystems();

        // Drive the side effects of a readiness change: publish the bridge's
        // online/offline status (hello/cgateweb via mqttManager) and refresh the
        // HA bridge diagnostics. Fires on every update() so behaviour matches the
        // original _updateBridgeReadiness, which always invoked both.
        this.bridgeReadiness.on('readinessChanged', ({ ready, reason }) => {
            this.mqttManager.setBridgeReady(ready, reason);
            this.haBridgeDiagnostics.publishNow(reason);
        });

        // The init service computes and returns an InitResult instead of
        // mutating the bridge directly. State the bridge owns and exposes to
        // other collaborators (haDiscovery, discoveredNetworks) is read back
        // through getters and written back through the apply* setters at the
        // exact point in the init flow it changes, preserving the timing the
        // bridge's live accessors depend on (e.g. getHaDiscovery for aircon/CNI).
        this.initializationService = new BridgeInitializationService({
            settings: this.settings,
            commandQueue: this.cgateCommandQueue,
            mqttManager: this.mqttManager,
            labelLoader: this.labelLoader,
            log: (message) => this.log(message),
            getCommandResponseProcessor: () => this.commandResponseProcessor,
            getDiscoveredNetworks: () => this.discoveredNetworks,
            getHaDiscovery: this._getHaDiscovery,
            applyDiscoveredNetworks: (networks) => { this.discoveredNetworks = networks; },
            applyHaDiscovery: (haDiscovery) => {
                this.haDiscovery = haDiscovery;
                this.commandResponseProcessor.haDiscovery = haDiscovery;
            },
            updateReadiness: (reason) => this._updateBridgeReadiness(reason)
        });
        this.commandResponseProcessor.onCommandError = (code, statusData) => {
            this.initializationService.handleCommandError(code, statusData);
        };
        this._setupEventHandlers();
    }

    /**
     * Builds all bridge subsystems in dependency order (managers, connection
     * pool, event connection, publisher, registries, web server, diagnostics,
     * and the extracted collaborators). Invokes _buildQueues and
     * _buildEventLogBuffer inline at the exact positions they ran in the
     * original constructor so initialization order is preserved.
     * @private
     */
    _buildSubsystems() {
        // Connection managers
        this.mqttManager = new MqttManager(this.settings);
        
        // Use connection pool for commands (performance optimization)
        // Event connection remains singular due to its broadcast nature
        this.commandConnectionPool = new CgateConnectionPool('command', this.settings.cbusip, this.settings.cbuscommandport, this.settings);
        this.eventConnection = new CgateConnection('event', this.settings.cbusip, this.settings.cbuseventport, this.settings);
        
        // Maintain backward compatibility - expose first connection from pool
        this.commandConnection = null; // Will be set after pool starts

        // Connection manager to coordinate all connections
        this.connectionManager = new ConnectionManager({
            mqttManager: this.mqttManager,
            commandConnectionPool: this.commandConnectionPool,
            eventConnection: this.eventConnection
        }, this.settings);
        
        // Service modules (haDiscovery will be initialized after pool starts)
        this.haDiscovery = null;

        // C-Gate command queue with throttling to avoid overwhelming serial protocol
        this._buildQueues();

        // Device state manager for coordinating device state between components
        this.deviceStateManager = new DeviceStateManager({
            settings: this.settings,
            logger: this.logger
        });

        // Tracks per-thermostat ward/zone/type state for native HVAC write control.
        this.airconControlRegistry = new AirconControlRegistry();

        // MQTT command router
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
        this.eventLineProcessor = new LineProcessor();
        // Networks discovered by the init service (via auto-discovery). Read live
        // by the init service and by _resolveGetallNetworks; starts unset.
        this.discoveredNetworks = null;

        // Owns lifecycle state + readiness reason; emits 'readinessChanged' which
        // the bridge subscribes to (after haBridgeDiagnostics is built) to drive
        // the hello/cgateweb status publish and diagnostics refresh.
        this.bridgeReadiness = new BridgeReadiness();

        // MQTT options
        this._mqttOptions = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };

        // Label loader for custom device names (before EventPublisher so it can use type overrides)
        this.labelLoader = new LabelLoader(this.settings.cbus_label_file || null);
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

        // Tracks CNI/PCI connectivity per C-Bus network (see networkInterfaceMonitor).
        this.networkInterfaceMonitor = new NetworkInterfaceMonitor({ logger: this.logger });

        // CNI online/offline state machine: publishes connectivity state and
        // raises/dismisses HA persistent notifications on transitions.
        this.cniNotificationManager = new CniNotificationManager({
            networkInterfaceMonitor: this.networkInterfaceMonitor,
            mqttManager: this.mqttManager,
            getHaDiscovery: this._getHaDiscovery,
            logger: this.logger,
            settings: this.settings,
            mqttOptions: this._mqttOptions
        });

        // Command response processor for handling C-Gate command responses
        this.commandResponseProcessor = new CommandResponseProcessor({
            eventPublisher: this.eventPublisher,
            haDiscovery: null, // Will be set after haDiscovery is initialized
            onObjectStatus: (event) => this.deviceStateManager.updateLevelFromEvent(event),
            onNetworkState: (networkId, reading) => this._handleNetworkInterfaceReading(networkId, reading),
            logger: this.logger
        });

        // Web server for label editing UI. In add-on mode nothing injects
        // INGRESS_ENTRY, so the ingress base path is discovered from the
        // Supervisor API after startup (see _discoverIngressBasePath);
        // INGRESS_ENTRY remains an explicit override when set.
        const ingressBasePath = process.env.INGRESS_ENTRY || '';
        this.webServer = new WebServer({
            port: this.settings.web_port || 8080,
            bindHost: this.settings.web_bind_host || '127.0.0.1',
            basePath: ingressBasePath,
            labelLoader: this.labelLoader,
            apiKey: this.settings.web_api_key || null,
            allowUnauthenticatedMutations: this.settings.web_allow_unauthenticated_mutations === true,
            allowedOrigins: this.settings.web_allowed_origins || null,
            maxMutationRequestsPerWindow: this.settings.web_mutation_rate_limit_per_minute || 120,
            maxBodySizeBytes: this.settings.webMaxBodySizeBytes,
            activeDeviceWindowMs: this.settings.web_active_device_window_ms,
            haAreasCacheTtlMs: this.settings.web_ha_areas_cache_ttl_ms,
            haApiTimeoutMs: this.settings.web_ha_api_timeout_ms,
            maxSseConnections: this.settings.web_max_sse_connections,
            _sseKeepaliveMs: this.settings.webSseKeepaliveMs,
            triggerAppId: this.settings.ha_discovery_trigger_app_id || null,
            getStatus: () => this._getBridgeStatus(),
            deviceStateManager: this.deviceStateManager,
            eventStream: this.eventStream
        });
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
        // C-Gate command queue with throttling to avoid overwhelming serial protocol
        const queueOptions = {
            maxSize: this.settings.maxQueueSize || 1000,
            getIntervalMs: () => this._getAdaptiveQueueIntervalMs(),
            canProcessFn: () => this._canProcessCommandQueue(),
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
            this.settings.messageinterval,
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
        const eventLogMax = Math.max(10, Number(this.settings.eventLogMaxEntries) || 200);
        this._eventLogBuffer = [];
        this._eventLogListeners = new Set();
        this._onEventLog = (entry) => {
            this._eventLogBuffer.push(entry);
            if (this._eventLogBuffer.length > eventLogMax) {
                this._eventLogBuffer.shift();
            }
            for (const fn of this._eventLogListeners) {
                try { fn(entry); } catch (e) { this.logger.debug('Event-log listener threw', { error: e }); }
            }
        };

        // eventStream interface for WebServer SSE endpoint
        this.eventStream = {
            subscribe: (fn) => { this._eventLogListeners.add(fn); },
            unsubscribe: (fn) => { this._eventLogListeners.delete(fn); },
            getRecent: () => [...this._eventLogBuffer]
        };
    }

    _setupEventHandlers() {
        // Connection manager handles all connection state coordination
        this.connectionManager.on('allConnected', () => {
            this._handleAllConnected();
        });
        this.commandConnectionPool.on('allConnectionsUnhealthy', () => this._updateBridgeReadiness('command-pool-unhealthy'));
        this.commandConnectionPool.on('connectionLost', () => this._updateBridgeReadiness('command-pool-connection-lost'));
        this.eventConnection.on('close', () => this._updateBridgeReadiness('event-disconnected'));
        this.eventConnection.on('error', () => this._updateBridgeReadiness('event-error'));
        this.mqttManager.on('close', () => this._updateBridgeReadiness('mqtt-disconnected'));

        // Set first connection for backward compatibility when pool starts
        this.commandConnectionPool.on('started', () => {
            const firstConnection = this.commandConnectionPool.connections[0];
            this.commandConnection = firstConnection;
        });

        // Reset line processor when a pool connection is replaced (reconnect)
        // to avoid stale partial-line buffers from the old connection
        this.commandConnectionPool.on('connectionAdded', ({ index }) => {
            const existing = this.commandLineProcessors.get(index);
            if (existing) {
                existing.close();
                this.commandLineProcessors.delete(index);
            }
        });

        // MQTT message routing
        this.mqttManager.on('message', (topic, payload) => this.mqttCommandRouter.routeMessage(topic, payload));

        // Data processing handlers - pass connection for per-connection line processing
        this.commandConnectionPool.on('data', (data, connection) => this._handleCommandData(data, connection));
        this.eventConnection.on('data', (data) => this._handleEventData(data));

        // MQTT command router event handlers
        this.mqttCommandRouter.on('haDiscoveryTrigger', () => {
            if (this.haDiscovery) {
                this.haDiscovery.trigger();
            }
        });
        this.mqttCommandRouter.on('treeRequest', (networkId) => {
            if (this.haDiscovery) this.haDiscovery.queueTreeRequest(networkId);
        });
    }

    /**
     * Starts the bridge by connecting to MQTT broker and C-Gate server.
     * 
     * This method initiates connections to:
     * - MQTT broker (for receiving commands and publishing events)
     * - C-Gate command port (for sending commands to C-Bus devices)
     * - C-Gate event port (for receiving C-Bus device events)
     * 
     * @returns {Promise<CgateWebBridge>} Returns this instance for method chaining
     */
    async start() {
        this.logger.info('Starting cgateweb bridge');
        this._setLifecycleState('booting', 'startup');
        this._updateBridgeReadiness('startup');

        // Start all connections via connection manager
        await this.connectionManager.start();
        this.haBridgeDiagnostics.start();
        this.haBridgeDiagnostics.publishNow('startup');
        this.staleDeviceDetector.start();
        this._updateBridgeReadiness('startup-complete');

        // Off the await chain so it never gates the critical startup path.
        this.webServer.start().catch((err) => {
            this.logger.warn(`Web server failed to start: ${err.message}`);
        });

        // Fire-and-forget alongside the web server: learns the ingress base
        // path and applies it once known (GitHub #33).
        this._discoverIngressBasePath();

        return this;
    }

    /**
     * Discovers the Home Assistant ingress entry path from the Supervisor API
     * and applies it to the web server (GitHub #33).
     *
     * The web auth hardening only trusts HA-ingress-authenticated requests when
     * the web server knows its ingress base path. The Supervisor never injects
     * INGRESS_ENTRY into add-on containers, so without this lookup every
     * ingress request 401s on a default install (no web_api_key). An explicit
     * INGRESS_ENTRY env var still wins and skips the lookup.
     * @private
     * @returns {Promise<void>|null} discovery completion (awaitable in tests)
     */
    _discoverIngressBasePath() {
        if (process.env.INGRESS_ENTRY) return null;
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (!supervisorToken) return null;

        return discoverIngressEntry({ token: supervisorToken })
            .then((ingressEntry) => {
                if (ingressEntry) {
                    this.webServer.setBasePath(ingressEntry);
                    return;
                }
                this.logger.warn(
                    'Could not determine the Home Assistant ingress path from the Supervisor API; ' +
                    'label saves and imports through the ingress panel will be rejected (401). ' +
                    'Set web_api_key to authenticate the web UI instead.'
                );
            })
            .catch((err) => {
                this.logger.warn(
                    `Ingress path discovery failed: ${err.message}. ` +
                    'Set web_api_key to authenticate the web UI through the ingress panel.'
                );
            });
    }

    /**
     * Stops the bridge and cleans up all resources.
     * 
     * This method:
     * - Clears any running periodic tasks
     * - Empties message queues
     * - Disconnects from MQTT broker and C-Gate server
     * - Resets connection state
     */
    async stop() {
        this.log(`Stopping cgateweb bridge...`);
        this._setLifecycleState('stopping', 'shutdown');
        this._updateBridgeReadiness('shutdown');

        // Remove all bridge-level event listeners before stopping subsystems
        // to prevent callbacks firing into a partially-stopped bridge during teardown
        this.connectionManager.removeAllListeners();
        this.commandConnectionPool.removeAllListeners();
        this.eventConnection.removeAllListeners();
        this.mqttManager.removeAllListeners();

        this.initializationService.stop();
        this.haBridgeDiagnostics.stop();
        this.staleDeviceDetector.stop();

        // Stop web server
        await this.webServer.close();

        // Clear queues
        this.cgateCommandQueue.clear();

        // Clean up line processors
        for (const processor of this.commandLineProcessors.values()) {
            processor.close();
        }
        this.commandLineProcessors.clear();
        this.eventLineProcessor.close();

        // Shut down event publisher, command router, and device state manager
        this.eventPublisher.shutdown();
        this.mqttCommandRouter.shutdown();
        this.mqttCommandRouter.coverRampTracker.cancelAll();
        this.deviceStateManager.shutdown();

        // Disconnect all connections via connection manager
        await this.connectionManager.stop();
    }

    _handleAllConnected() {
        // The init service applies the bridge-owned state (haDiscovery,
        // discoveredNetworks) in-flight through the apply* setters wired in the
        // constructor, so the bridge's live accessors observe it at the same
        // moment as before. The returned InitResult is the explicit contract
        // (used by tests and any awaiting caller); production fires this without
        // awaiting, exactly as before.
        return this.initializationService.handleAllConnected();
    }

    // MQTT message handling now delegated to MqttCommandRouter



    _handleCommandData(data, connection) {
        const key = connection.poolIndex !== undefined ? connection.poolIndex : connection;
        let processor = this.commandLineProcessors.get(key);
        if (!processor) {
            processor = new LineProcessor();
            this.commandLineProcessors.set(key, processor);
        }
        processor.processData(data, (line) => {
            try {
                this.commandResponseProcessor.processLine(line);
            } catch (e) {
                this.error(`Error processing command data line: ${e.message}`, { line });
            }
        });
    }



    _handleEventData(data) {
        this.eventLineProcessor.processData(data, (line) => {
            this._processEventLine(line);
        });
    }

    /**
     * Delegates native-aircon (app 172) event-line handling to AirconEventHandler.
     * Returns true when the line was an aircon line and was consumed there.
     */
    _handleAirconLine(line) {
        return this.airconEventHandler.handleLine(line);
    }

    _processEventLine(line) {
        if (this._handleAirconLine(line)) return;

        if (line.startsWith('#')) {
            this.logger.debug(`Ignoring comment from event port: ${line}`);
            return;
        }

        if (line.startsWith('clock ')) {
            this.logger.debug(`Ignoring clock event from event port: ${line}`);
            return;
        }

        // C-Gate "Network sync ok" status event (code 762, visible at event
        // level 6+): the network finished synchronising, so its tree is now
        // fully populated. Forward to HA Discovery to re-fetch groups that
        // were still empty (unsynced) at startup (issue #25). Not a CBusEvent,
        // so return before the standard parse (avoids a spurious warning).
        const syncedNetworkId = this._parseNetworkSyncComplete(line);
        if (syncedNetworkId) {
            this.logger.info(`C-Gate event: network ${syncedNetworkId} sync complete`);
            if (this.haDiscovery) {
                this.haDiscovery.handleNetworkSyncComplete(syncedNetworkId);
            }
            return;
        }

        this._publishRawEventCapture(line);

        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`C-Gate Recv (Evt): ${line}`);
        }

        // Aircon-format lines that weren't consumed above (feature disabled, an
        // unsupported verb, or a different app) are surfaced in raw capture but
        // are never valid CBusEvents — skip the parse so they don't spam a
        // "Could not parse event line" warning on every broadcast.
        if (this.airconEventHandler.isAirconLine(line)) {
            this.logger.debug(`Unparsed aircon line (captured, not a standard event): ${line}`);
            return;
        }

        try {
            const event = new CBusEvent(line);
            if (event.isValid()) {
                this.eventPublisher.publishEvent(event, '(Evt)');
                this.deviceStateManager.updateLevelFromEvent(event);
                // Temperature Broadcast (app 25) sensors announce themselves on
                // the bus — publish their HA sensor config the first time each
                // group is seen. Idempotent; gated on ha_discovery_enabled inside.
                if (this.haDiscovery) {
                    const reading = typeof event.getReading === 'function' ? event.getReading() : null;
                    if (reading && reading.kind === 'temperature') {
                        this.haDiscovery.ensureTemperatureDiscovery(event.getNetwork(), event.getApplication(), reading.group);
                    }
                }
            } else {
                this.warn(`Could not parse event line: ${line}`);
            }
        } catch (e) {
            this.error(`Error processing event data line: ${e.message}`, { line });
        }
    }



    /**
     * Parses a C-Gate "Network sync ok" status event (event code 762) from an
     * event-port line, e.g. "20260718-123456.789 762 //PROJECT/254 Network
     * sync ok". Returns the network id string, or null when the line is not a
     * sync-complete event.
     */
    _parseNetworkSyncComplete(line) {
        const match = line.match(CGATE_EVENT_NETWORK_SYNC_REGEX);
        return match ? match[1] : null;
    }

    /**
     * If the event's application is listed in settings.cbusRawEventLogApps, log
     * the verbatim line and publish it to cbus/read/{net}/{app}/{group}/raw for
     * protocol capture. Cheap, allocation-light app extraction so it can safely
     * run on every event line (including ones the standard parser can't decode).
     */
    _publishRawEventCapture(line) {
        const target = parseRawCaptureTarget(line, this.settings.cbusRawEventLogApps);
        if (!target) return;

        this.logger.info(`C-Gate raw capture [app ${target.application}]: ${line}`);
        try {
            this.mqttManager.publish(
                `cbus/read/${target.network}/${target.application}/${target.group}/raw`,
                line,
                { retain: false, qos: 0 }
            );
        } catch (e) {
            this.logger.debug(`Raw capture publish failed: ${e.message}`);
        }
    }

    // Event publishing now delegated to EventPublisher

    async _sendCgateCommand(command) {
        try {
            await this.commandConnectionPool.execute(command);
        } catch (error) {
            this.logger.error('Failed to send C-Gate command:', { command, error });
            const trimmed = String(command || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            const detail = error && error.message ? error.message : String(error);
            this.mqttManager.publish(
                'hello/cgateweb/warnings',
                `C-Gate command send failed: ${trimmed} (${detail})`,
                { retain: false }
            );
        }
    }

    _canProcessCommandQueue() {
        const stats = this.commandConnectionPool?.getStats?.();
        return !!(stats && stats.isStarted && !stats.isShuttingDown && stats.healthyConnections > 0);
    }

    _getAdaptiveQueueIntervalMs() {
        const baseInterval = clampSetting(this.settings.messageinterval, 10, 200);
        const minInterval = clampSetting(this.settings.commandMinIntervalMs, 5, 10);
        const stats = this.commandConnectionPool?.getStats?.();
        if (!stats || stats.healthyConnections <= 0) {
            return baseInterval;
        }

        // Scale interval by writable healthy connections and queue pressure.
        const writableConnections = Math.max(1, stats.writableConnections || stats.healthyConnections);
        const queueDepth = this.cgateCommandQueue?.length || 0;
        const depthMultiplier = queueDepth > (writableConnections * 20) ? 0.5 : 1;
        const interval = Math.round((baseInterval / writableConnections) * depthMultiplier);
        return Math.max(minInterval, interval);
    }

    /**
     * Logs an informational message.
     * 
     * @param {string} message - The message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    log(message, meta = {}) {
        this.logger.info(message, meta);
    }

    /**
     * Logs a warning message.
     * 
     * @param {string} message - The warning message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    /**
     * Logs an error message.
     * 
     * @param {string} message - The error message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    /**
     * Handle a network InterfaceState/State reading. Delegates to the CNI
     * notification manager, which tracks it, publishes the retained connectivity
     * state for the binary_sensor, ensures the discovery entity exists, and
     * (optionally) raises/clears an HA notification on transitions.
     */
    _handleNetworkInterfaceReading(networkId, reading) {
        return this.cniNotificationManager.handleReading(networkId, reading);
    }

    _getBridgeStatus() {
        const commandStats = this.commandConnectionPool ? this.commandConnectionPool.getStats() : null;
        const mqttConnected = !!this.mqttManager.connected;
        const eventConnected = !!this.eventConnection.connected;
        const healthyCommandConnections = commandStats ? commandStats.healthyConnections : 0;
        const ready = mqttConnected && eventConnected && healthyCommandConnections > 0;

        return {
            version: require('../package.json').version,
            uptime: process.uptime(),
            ready,
            lifecycle: this.bridgeReadiness.getLifecycleSnapshot(),
            connections: {
                mqtt: mqttConnected,
                commandPool: {
                    started: commandStats ? commandStats.isStarted : false,
                    healthyConnections: healthyCommandConnections,
                    totalConnections: commandStats ? commandStats.totalConnections : 0,
                    pendingReconnects: commandStats ? commandStats.pendingReconnects : 0,
                    isShuttingDown: commandStats ? commandStats.isShuttingDown : false
                },
                event: eventConnected,
                eventReconnectAttempts: this.eventConnection?.reconnectAttempts || 0
            },
            metrics: {
                commandQueue: {
                    ...this.cgateCommandQueue.getStats()
                },
                publisher: this.eventPublisher?.getStats ? this.eventPublisher.getStats() : null
            },
            discovery: this.haDiscovery ? {
                count: this.haDiscovery.discoveryCount,
                labelStats: this.haDiscovery.labelStats
            } : null,
            cbusNetworks: this.networkInterfaceMonitor.getSnapshot()
        };
    }

    _updateBridgeReadiness(reason = 'state-change') {
        const commandStats = this.commandConnectionPool ? this.commandConnectionPool.getStats() : null;
        return this.bridgeReadiness.update({
            mqttConnected: this.mqttManager.connected,
            eventConnected: this.eventConnection.connected,
            healthyCommandConnections: commandStats ? commandStats.healthyConnections : 0
        }, reason);
    }

    _setLifecycleState(state, reason) {
        return this.bridgeReadiness.setLifecycleState(state, reason);
    }

    // Hot-reloads settings that can be applied without reconnecting.
    // Connection settings (mqtt host, cbus ip, ports) require a full restart.
    reloadSettings(newSettings) {
        const reloadableKeys = ['log_level', 'messageinterval', 'commandMinIntervalMs', 'getallperiod', 'getall_app_periods'];
        const changed = reloadableKeys.filter(k => newSettings[k] !== this.settings[k]);

        for (const k of reloadableKeys) {
            this.settings[k] = newSettings[k];
        }

        if (newSettings.log_level) {
            this._applyLogLevel(newSettings.log_level);
        }

        const getallNetworks = this.initializationService._resolveGetallNetworks();
        if (getallNetworks.length > 0 && (this.settings.getallperiod || this.settings.getall_app_periods)) {
            this.initializationService._scheduleAllGetalls(getallNetworks);
        }

        this.labelLoader.load();

        if (changed.length > 0) {
            this.logger.info(`Settings reloaded. Changed: ${changed.join(', ')}`);
        } else {
            this.logger.info('Settings reloaded (no changes detected)');
        }
    }

    _applyLogLevel(level) {
        [
            this.logger,
            this.mqttManager?.logger,
            this.commandConnectionPool?.logger,
            this.eventConnection?.logger,
            this.commandResponseProcessor?.logger,
            this.initializationService?.logger,
            this.mqttCommandRouter?.logger,
            this.eventPublisher?.logger,
            this.connectionManager?.logger,
        ].filter(Boolean).forEach(l => l.setLevel(level));
    }

    // Legacy method compatibility for tests
    _connectMqtt() {
        return this.mqttManager.connect();
    }

    _connectCommandSocket() {
        return this.commandConnection.connect();
    }

    _connectEventSocket() {
        return this.eventConnection.connect();
    }


}

module.exports = CgateWebBridge;