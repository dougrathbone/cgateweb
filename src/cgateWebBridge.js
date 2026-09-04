// @ts-check
const BridgeInitializationService = require('./bridgeInitializationService');
const CBusEvent = require('./cbusEvent');
const { LINE_UNPARSED } = require('./applicationDecoders/appEventLine');
const clockDecoder = require('./applicationDecoders/clockDecoder');
const { discoverIngressEntry } = require('./ingressDiscovery');
const { createLogger, resolveLogLevelFromSettings } = require('./logger');
const { LineProcessor } = require('./lineProcessor');
const { CGATE_EVENT_NETWORK_SYNC_REGEX } = require('./constants');
const { redactCgateLine } = require('./utils');
const { parseRawCaptureTarget } = require('./rawEventCapture');
const { resolveSetting } = require('./config/schema');

// Publish options for the raw event capture topic: never retained, prebuilt
// once (mqtt.js does not mutate the options object) instead of per line.
const RAW_CAPTURE_MQTT_OPTIONS = Object.freeze({ retain: false, qos: 0 });

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
 *   cbuseventport: 20025,
 *   cbusname: 'SHAC'
 * });
 * bridge.start();
 *
 * Subsystem fields below are installed by cgateWebBridgeBuild.js (Object.assign
 * at module load). Declared here so @ts-check can resolve them. Do not declare
 * mixin *methods* as class fields — that shadows the prototype with undefined.
 */

/**
 * Methods mixed into CgateWebBridge.prototype from cgateWebBridgeBuild.js
 * at module load (see the Object.assign call at the bottom of this file).
 * @typedef {Object} CgateWebBridgeBuildMethods
 * @property {() => void} _buildSubsystems
 * @property {() => void} _buildQueues
 * @property {() => void} _buildEventLogBuffer
 * @property {() => void} _buildConnections
 * @property {() => void} _buildCommandRouting
 * @property {() => void} _buildLabelsAndPublisher
 * @property {() => void} _buildDomainEventHandlers
 * @property {() => void} _buildNetworkMonitoring
 * @property {() => void} _buildCommandResponseProcessor
 * @property {() => void} _buildWebAndDiagnostics
 */
class CgateWebBridge {
    /** @type {*} */
    mqttManager;
    /** @type {*} */
    commandConnectionPool;
    /** @type {*} */
    eventConnection;
    /** @type {*|null} */
    commandConnection;
    /** @type {*} */
    connectionManager;
    /** @type {*|null} */
    haDiscovery;
    /** @type {*} */
    cgateCommandQueue;
    /** @type {*} */
    deviceStateManager;
    /** @type {*} */
    airconControlRegistry;
    /** @type {*} */
    mqttCommandRouter;
    /** @type {Map<*, *>} */
    commandLineProcessors;
    /** @type {*} */
    eventLineProcessor;
    /** @type {Array<number>|null} */
    discoveredNetworks;
    /** @type {Map<string, {lastRunAt: number, burstStartedAt: number, syncs: number, deferHandle: (NodeJS.Timeout|null)}>} */
    _networkSyncState;
    /** @type {*} */
    bridgeReadiness;
    /** @type {Object} */
    _mqttOptions;
    /** @type {*} */
    labelLoader;
    /** @type {number} */
    _eventLogSize;
    /** @type {Array<*>} */
    _eventLogBuffer;
    /** @type {number} */
    _eventLogHead;
    /** @type {number} */
    _eventLogCount;
    /** @type {Set<Function>} */
    _eventLogListeners;
    /** @type {(entry: *) => void} */
    _onEventLog;
    /** @type {{subscribe: Function, unsubscribe: Function, getRecent: Function}} */
    eventStream;
    /** @type {*} */
    eventPublisher;
    /** @type {*} */
    airconEventHandler;
    /** @type {*} */
    securityEventHandler;
    /** @type {*} */
    measurementEventHandler;
    /** @type {*} */
    stateResyncCoordinator;
    /** @type {*} */
    networkInterfaceMonitor;
    /** @type {*} */
    serialDeviceRecovery;
    /** @type {*} */
    cniNotificationManager;
    /** @type {*} */
    commandResponseProcessor;
    /** @type {*} */
    webServer;
    /** @type {*} */
    haBridgeDiagnostics;
    /** @type {*} */
    staleDeviceDetector;
    /** @type {*} */
    initializationService;

    /**
     * Creates a new CgateWebBridge instance.
     * 
     * @param {Object} settings - Configuration settings for the bridge
     * @param {string} settings.mqtt - MQTT broker URL (e.g., 'mqtt://localhost:1883')
     * @param {string} settings.cbusip - C-Gate server IP address
     * @param {number} settings.cbuscommandport - C-Gate command port (typically 20023)
     * @param {number} settings.cbuseventport - C-Gate event port (typically 20025)
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
            level: resolveLogLevelFromSettings(this.settings),
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

        // Construct all subsystems in dependency order (see cgateWebBridgeBuild.js).
        /** @type {CgateWebBridge & CgateWebBridgeBuildMethods} */
        const build = /** @type {any} */ (this);
        build._buildSubsystems();

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
            // Constructed later in the build sequence (like commandResponseProcessor),
            // so read it live. Owns the security status_request dedupe.
            getSecurityEventHandler: () => this.securityEventHandler,
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

        // Home Assistant restarted: it has lost every entity state it was
        // holding, and the add-on kept running, so nothing else would resend it.
        this.mqttManager.on('haOnline', () => {
            this.logger.info('Home Assistant came online; resyncing entity state');
            this.stateResyncCoordinator.requestResync('ha-birth');
        });

        // A mid-session broker reconnect may have dropped the retained discovery
        // configs along with the state, so this path republishes both. The
        // diagnostics and stale-device configs bypass HaDiscovery's recorder,
        // so they are replayed here explicitly.
        this.mqttManager.on('reconnect', () => {
            this.stateResyncCoordinator.requestResync('mqtt-reconnect');
            this.haBridgeDiagnostics.republishDiscovery();
            this.staleDeviceDetector.republishDiscovery();
        });

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

        return discoverIngressEntry({
            token: supervisorToken,
            timeoutMs: resolveSetting(this.settings, 'ingressDiscoveryTimeoutMs'),
            attempts: resolveSetting(this.settings, 'ingressDiscoveryAttempts'),
            initialRetryDelayMs: resolveSetting(this.settings, 'ingressDiscoveryInitialRetryDelayMs'),
            maxRetryDelayMs: resolveSetting(this.settings, 'ingressDiscoveryMaxBackoffMs')
        })
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
        this.stateResyncCoordinator.dispose();
        this._clearNetworkSyncTimers();
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



    _createLineProcessor() {
        return new LineProcessor({
            maxBufferBytes: resolveSetting(this.settings, 'cgateLineBufferMaxBytes')
        });
    }

    _handleCommandData(data, connection) {
        const key = connection.poolIndex !== undefined ? connection.poolIndex : connection;
        let processor = this.commandLineProcessors.get(key);
        if (!processor) {
            processor = this._createLineProcessor();
            this.commandLineProcessors.set(key, processor);
        }
        processor.processData(data, (line) => {
            try {
                this.commandResponseProcessor.processLine(line);
            } catch (e) {
                this.error(`Error processing command data line: ${e.message}`, { line: redactCgateLine(line) });
            }
        });
    }



    _handleEventData(data) {
        this.eventLineProcessor.processData(data, (line) => {
            // Mirrors the try/catch on the command path. Without it a throw
            // from any decoder reaches process.on('uncaughtException') in
            // index.js, which stops the bridge and exits - LineProcessor
            // deliberately re-throws with context, and CgateConnection emits
            // 'data' synchronously, so nothing in between catches it. That put
            // the two most complex and most externally-exposed parsers
            // (aircon and security) on the one data path with no safety net,
            // and C-Gate is unauthenticated on the LAN.
            try {
                this._processEventLine(line);
            } catch (e) {
                this.error(`Error processing event data line: ${e.message}`, { line: redactCgateLine(line) });
            }
        });
    }

    /**
     * Delegates native-aircon (app 172) event-line handling to AirconEventHandler.
     * Returns the handler's tri-state: true (consumed), LINE_UNPARSED (aircon
     * traffic the handler didn't consume), or false (not aircon traffic).
     */
    _handleAirconLine(line) {
        return this.airconEventHandler.handleLine(line);
    }

    /**
     * Delegates security (app 208) event-line handling to SecurityEventHandler.
     * Returns the handler's tri-state: true (consumed), LINE_UNPARSED (security
     * traffic the handler didn't consume), or false (not security traffic).
     */
    _handleSecurityLine(line) {
        return this.securityEventHandler.handleLine(line);
    }

    /**
     * Delegates native-measurement (app 228) event-line handling to
     * MeasurementEventHandler. Returns the handler's tri-state: true
     * (consumed), LINE_UNPARSED (measurement traffic the handler didn't
     * consume), or false (not measurement traffic).
     */
    _handleMeasurementLine(line) {
        return this.measurementEventHandler.handleLine(line);
    }

    /**
     * Handles C-Bus Clock and Timekeeping (app 223 / $DF) event lines.
     *
     * Clock lines are ALWAYS claimed, whether or not the feature is on, for the
     * same reason measurement lines are (see the class note in
     * src/measurementEventHandler.js): their address has two segments
     * (`//PROJECT/<net>/<app>`, no group) and they are not `#`-comment-prefixed,
     * so left alone they reach CBusEvent, whose EVENT_REGEX needs three
     * segments, and warn-spam the log on every clock tick. Silencing that spam
     * is why these lines were dropped outright in 833b60e; the setting only
     * decides whether they are also decoded and published.
     *
     * @param {string} line
     * @returns {true|typeof LINE_UNPARSED|false} true if consumed, LINE_UNPARSED
     *   for clock traffic left undecoded (feature off, or a shape the decoder
     *   will not guess at), false if not clock traffic.
     */
    _handleClockLine(line) {
        if (!clockDecoder.isClockLine(line)) return false;

        // Own CLOCK REQUEST_REFRESH echo (sourceunit=0). Not a reading; consume
        // it so it does not log as an unparsed clock line (#66).
        if (clockDecoder.isClockRequestRefreshLine(line)) return true;

        if (!this.settings.cbus_clock_enabled) return LINE_UNPARSED;

        const reading = clockDecoder.decodeLine(line);
        if (!reading) return LINE_UNPARSED;

        // No group address exists for Clock (net/app only), so 'clock' stands in
        // as the group segment, giving cbus/read/{net}/223/clock/{date|time}.
        this.eventPublisher.publishReading(reading.network, reading.application, 'clock', reading);

        if (this.haDiscovery) {
            this.haDiscovery.ensureClockDiscovery(reading.network, reading.application);
        }
        return true;
    }

    _processEventLine(line) {
        // Security lines are `#`-comment-prefixed like aircon lines; consume
        // them before the generic comment-dropping branch so zone events don't
        // publish a bogus OFF and status reports don't warn-spam the parser.
        // All three handlers classify the line exactly once and report a
        // tri-state, which the unparsed branches below reuse instead of
        // re-scanning.
        const airconState = this._handleAirconLine(line);
        if (airconState === true) return;
        const securityState = this._handleSecurityLine(line);
        if (securityState === true) return;
        const measurementState = this._handleMeasurementLine(line);
        if (measurementState === true) return;
        // Ahead of the comment branch like aircon/security: the captured clock
        // lines are not `#`-prefixed, but claiming them here means a
        // comment-prefixed variant is handled the same way rather than being
        // swallowed as a generic comment.
        const clockState = this._handleClockLine(line);
        if (clockState === true) return;

        if (line.startsWith('#')) {
            this.logger.debug(`Ignoring comment from event port: ${redactCgateLine(line)}`);
            return;
        }

        // C-Gate "Network sync ok" status event (code 762, visible at event
        // level 6+): the network finished synchronising, so its tree is now
        // fully populated. Not a CBusEvent, so return before the standard
        // parse (avoids a spurious warning).
        const syncedNetworkId = this._parseNetworkSyncComplete(line);
        if (syncedNetworkId) {
            this._handleNetworkSyncComplete(syncedNetworkId);
            return;
        }

        this._publishRawEventCapture(line);

        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            // Redacted: keypad command echoes reach the event port too, each
            // carrying a digit of the user's alarm PIN (#51).
            this.logger.debug(`C-Gate Recv (Evt): ${redactCgateLine(line)}`);
        }

        // App lines the handlers recognised but didn't consume (an unsupported
        // verb or a different app) are surfaced in raw capture but are never
        // valid CBusEvents — skip the parse so they don't spam a "Could not
        // parse event line" warning on every broadcast. The handlers already
        // classified the line, so these reuse their tri-state instead of
        // re-scanning with isAirconLine/isSecurityLine.
        if (airconState === LINE_UNPARSED) {
            this.logger.debug(`Unparsed aircon line (captured, not a standard event): ${redactCgateLine(line)}`);
            return;
        }
        if (securityState === LINE_UNPARSED) {
            this.logger.debug(`Unparsed security line (captured, not a standard event): ${redactCgateLine(line)}`);
            return;
        }
        if (measurementState === LINE_UNPARSED) {
            this.logger.debug(`Unparsed measurement line (captured, not a standard event): ${redactCgateLine(line)}`);
            return;
        }
        // Reached when the feature is off, or on but the line was a shape the
        // decoder refuses to guess at. Either way it has now passed through
        // _publishRawEventCapture above, so `cbusRawEventLogApps` can capture
        // real app-223 traffic without decoding it blind. Known
        // `request_refresh` echoes are consumed in _handleClockLine instead.
        if (clockState === LINE_UNPARSED) {
            this.logger.debug(`Unparsed clock line (captured, not a standard event): ${redactCgateLine(line)}`);
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
                    const reading = /** @type {{ kind?: string, group?: string } | null} */ (typeof event.getReading === 'function' ? event.getReading() : null);
                    if (reading && reading.kind === 'temperature') {
                        this.haDiscovery.ensureTemperatureDiscovery(event.getNetwork(), event.getApplication(), reading.group);
                    }
                    this.haDiscovery.ensureUnlistedGroupDiscovery?.(event.getNetwork(), event.getApplication(), event.getGroup());
                }
            } else {
                this.warn(`Could not parse event line: ${redactCgateLine(line)}`);
            }
        } catch (e) {
            this.error(`Error processing event data line: ${e.message}`, { line: redactCgateLine(line) });
        }
    }



    /**
     * Single entry point for C-Gate's "Network sync ok" (762), reached from
     * both the event-port line (_processEventLine) and the command-port async
     * event (CommandResponseProcessor onNetworkSyncComplete).
     *
     * One network sync produces several notifications - one per pooled command
     * connection, since each subscribes at event level 6, plus the event port -
     * and a network whose CNI/PCI link is flapping re-syncs every few seconds.
     * The post-sync work is not free (a TREEXML, a level getall, a security
     * status_request pair and a clock refresh, the last two being real C-Bus
     * traffic), so running it per notification turned one unstable interface
     * into a permanent flood that C-Gate answered with 408s on everything,
     * including the switch commands the user was pressing.
     *
     * So notifications are collapsed here rather than at each effect: repeats
     * within networkSyncCoalesceMs are the same sync arriving on the other
     * connections, and anything sooner than networkSyncMinIntervalMs after the
     * last refresh is deferred to that boundary and collapsed into one run.
     */
    _handleNetworkSyncComplete(networkId) {
        this.logger.info(`C-Gate event: network ${networkId} sync complete`);
        if (this._acceptNetworkSyncNotification(networkId)) {
            this._runPostNetworkSyncRefresh(networkId);
        }
    }

    /**
     * Rate-limits post-sync refreshes for one network. Returns true when the
     * caller should refresh now; false when this notification was a duplicate
     * of the last sync or has been deferred into a pending run.
     *
     * @param {string} networkId
     * @returns {boolean}
     * @private
     */
    _acceptNetworkSyncNotification(networkId) {
        const key = String(networkId);
        const now = Date.now();
        const coalesceMs = resolveSetting(this.settings, 'networkSyncCoalesceMs');
        const minIntervalMs = resolveSetting(this.settings, 'networkSyncMinIntervalMs');

        let state = this._networkSyncState.get(key);
        if (!state) {
            state = { lastRunAt: 0, burstStartedAt: 0, syncs: 0, deferHandle: null };
            this._networkSyncState.set(key, state);
        }

        // Copies of one sync from the other pooled connections and the event
        // port. Measured from the start of the burst rather than from the last
        // copy, so a network that reports faster than the window cannot keep
        // extending it and starve the refresh entirely.
        if (state.burstStartedAt > 0 && now - state.burstStartedAt < coalesceMs) {
            this.logger.debug(`Duplicate network ${key} sync notification; already counted`);
            return false;
        }
        state.burstStartedAt = now;
        state.syncs++;

        if (state.deferHandle) {
            this.logger.debug(`Network ${key} sync folded into the pending post-sync refresh`);
            return false;
        }

        const sinceLastRun = now - state.lastRunAt;
        if (state.lastRunAt > 0 && sinceLastRun < minIntervalMs) {
            const waitMs = minIntervalMs - sinceLastRun;
            this.warn(
                `C-Bus network ${key} has reported sync complete ${state.syncs} times since the last refresh ` +
                `(${Math.round(sinceLastRun / 1000)}s ago); deferring the next refresh ${Math.round(waitMs / 1000)}s to ` +
                'avoid flooding C-Gate. Repeated syncs usually mean the CNI/PCI interface is dropping.'
            );
            state.deferHandle = setTimeout(() => {
                state.deferHandle = null;
                this._runPostNetworkSyncRefresh(key);
            }, waitMs);
            if (typeof state.deferHandle.unref === 'function') state.deferHandle.unref();
            return false;
        }

        return true;
    }

    /**
     * Runs every post-sync effect once for a network:
     *   - HA Discovery re-fetches the now fully-populated tree to pick up
     *     groups that were still empty (unsynced) at startup (issue #25)
     *   - security zone-state refresh, deduplicated inside the handler
     *     (one post-762 pair per network per session)
     *   - lighting level resync: any startup getall that ran before the sync
     *     missed state (issue #44); debounced inside the coordinator
     *
     * @param {string} networkId
     * @private
     */
    _runPostNetworkSyncRefresh(networkId) {
        const state = this._networkSyncState.get(String(networkId));
        if (state) {
            state.lastRunAt = Date.now();
            state.syncs = 0;
        }
        if (this.haDiscovery) {
            this.haDiscovery.handleNetworkSyncComplete(networkId);
        }
        this.securityEventHandler.requestStatusSync(networkId, 'sync');
        this.stateResyncCoordinator.requestResync('network-sync');
    }

    /**
     * Cancel any deferred post-sync refresh (bridge shutdown).
     * @private
     */
    _clearNetworkSyncTimers() {
        for (const state of this._networkSyncState.values()) {
            if (state.deferHandle) {
                clearTimeout(state.deferHandle);
                state.deferHandle = null;
            }
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

        this.logger.info(`C-Gate raw capture [app ${target.application}]: ${redactCgateLine(line)}`);
        try {
            this.mqttManager.publish(
                // Redacted like the log line above. Redacting one and not the
                // other was the original 1.24.3 miss: this publishes off-box to
                // every broker subscriber, so it is the worse of the two (#51).
                `cbus/read/${target.network}/${target.application}/${target.group}/raw`,
                redactCgateLine(line),
                RAW_CAPTURE_MQTT_OPTIONS
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
            // Redacted both here and in the published warning below: a failed
            // send is exactly how a keypad command with a PIN digit ends up in
            // the log and on the broker (#51). Logger redaction is key-name
            // based, so `command` is not covered by it.
            const safeCommand = redactCgateLine(String(command || ''));
            this.logger.error('Failed to send C-Gate command:', { command: safeCommand, error });
            const trimmed = safeCommand.replace(/\s+/g, ' ').trim().slice(0, 120);
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
        const baseInterval = Math.max(
            resolveSetting(this.settings, 'messageIntervalMinMs'),
            resolveSetting(this.settings, 'messageinterval')
        );
        const minInterval = Math.max(
            resolveSetting(this.settings, 'commandMinIntervalFloorMs'),
            resolveSetting(this.settings, 'commandMinIntervalMs')
        );
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
        if (getallNetworks.length > 0 && (resolveSetting(this.settings, 'getallperiod') || resolveSetting(this.settings, 'getall_app_periods'))) {
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

}

Object.assign(CgateWebBridge.prototype, require('./cgateWebBridgeBuild'));
module.exports = CgateWebBridge;