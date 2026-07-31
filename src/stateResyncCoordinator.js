// @ts-check
'use strict';

const { CGATE_CMD_GET, CGATE_PARAM_LEVEL, NEWLINE } = require('./constants');

/**
 * Republishes entity state after Home Assistant or the MQTT broker restarts
 * (issue #44).
 *
 * Neither restart is visible as a bridge restart, so nothing would otherwise
 * refresh Home Assistant:
 *
 *  - HA restarting does not restart the add-on and does not drop the bridge's
 *    own broker connection. With retainreads off (the default) HA comes back
 *    with no retained state to read, so entities sit unknown until the next
 *    physical C-Bus event — the "two lightning bolts that snap to a real icon
 *    on first use" in the issue.
 *  - The broker restarting drops the retained discovery configs too if it has
 *    no persistence, so the entities disappear entirely rather than merely
 *    losing state.
 *
 * Both triggers route through one debounce so a broker bounce that also
 * restarts HA resyncs once rather than twice.
 */
class StateResyncCoordinator {
    /**
     * @param {Object} deps
     * @param {Object} deps.settings
     * @param {{ add: (cmd: string) => void }} deps.commandQueue
     * @param {ReturnType<typeof import('./logger').createLogger>} deps.logger
     * @param {() => (Object|null)} deps.getHaDiscovery - late-bound: haDiscovery is built after the bridge constructor
     * @param {() => (Object|null)} deps.getSecurityEventHandler
     * @param {{ _resolveGetallNetworks: () => string[] }} deps.initializationService
     */
    constructor({ settings, commandQueue, logger, getHaDiscovery, getSecurityEventHandler, initializationService }) {
        this.settings = settings;
        this.commandQueue = commandQueue;
        this.logger = logger;
        this.getHaDiscovery = getHaDiscovery;
        this.getSecurityEventHandler = getSecurityEventHandler;
        this.initializationService = initializationService;

        /** @type {NodeJS.Timeout|null} */
        this._pending = null;
        /** @type {Set<string>} triggers collapsed into the pending resync */
        this._pendingTriggers = new Set();
        // Sticky across collapsed triggers: if any of them wanted the configs
        // republished, the single resync that runs must do it.
        this._pendingRepublishDiscovery = false;
    }

    /**
     * Request a resync. Repeated calls inside the debounce window collapse into
     * one.
     *
     * @param {'ha-birth'|'mqtt-reconnect'|string} trigger
     * @param {{ republishDiscovery?: boolean }} [options]
     * @returns {boolean} true when a resync is now pending
     */
    requestResync(trigger, options = {}) {
        if (!this._triggerEnabled(trigger)) {
            this.logger.debug(`State resync trigger '${trigger}' is disabled by settings`);
            return false;
        }

        this._pendingTriggers.add(trigger);
        if (options.republishDiscovery) this._pendingRepublishDiscovery = true;

        if (this._pending) clearTimeout(this._pending);
        const debounceMs = Number(this.settings.stateResyncDebounceMs) || 5000;
        this._pending = setTimeout(() => this._runResync(), debounceMs);
        if (typeof this._pending.unref === 'function') this._pending.unref();
        return true;
    }

    /**
     * Cancel any pending resync (bridge shutdown).
     */
    dispose() {
        if (this._pending) {
            clearTimeout(this._pending);
            this._pending = null;
        }
        this._pendingTriggers.clear();
        this._pendingRepublishDiscovery = false;
    }

    /**
     * @param {string} trigger
     * @returns {boolean}
     * @private
     */
    _triggerEnabled(trigger) {
        if (trigger === 'ha-birth') return this.settings.stateResyncOnHaRestart !== false;
        if (trigger === 'mqtt-reconnect') return this.settings.stateResyncOnMqttReconnect !== false;
        return true;
    }

    /**
     * @private
     */
    _runResync() {
        this._pending = null;
        const triggers = [...this._pendingTriggers].join(', ');
        const republishDiscovery = this._pendingRepublishDiscovery;
        this._pendingTriggers.clear();
        this._pendingRepublishDiscovery = false;

        let configs = 0;
        if (republishDiscovery) {
            const haDiscovery = this.getHaDiscovery();
            if (haDiscovery && typeof haDiscovery.republishDiscoveryConfigs === 'function') {
                configs = haDiscovery.republishDiscoveryConfigs();
            }
        }

        const netapps = this.initializationService._resolveGetallNetworks();
        if (netapps.length === 0) {
            this.logger.debug(
                `State resync (${triggers}) had no getall networks configured, so no levels were requested`
            );
            return;
        }

        for (const netapp of netapps) {
            this.commandQueue.add(
                `${CGATE_CMD_GET} //${this.settings.cbusname}/${netapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
            );
        }

        // Security panels do not answer lighting-style getall (spec §5.9), so
        // the zone sensors need their own status_request pair or they would stay
        // stale across exactly the restart this coordinator exists to fix.
        const securityEventHandler = this.getSecurityEventHandler();
        const networks = new Set(netapps.map((netapp) => String(netapp).split('/')[0]));
        if (securityEventHandler && typeof securityEventHandler.requestStatusSync === 'function') {
            for (const network of networks) {
                securityEventHandler.requestStatusSync(network, 'resync');
            }
        }

        this.logger.info(
            `State resync (${triggers}): requested levels for ${netapps.length} network/app pair(s), ` +
            `${networks.size} security status sync(s)` +
            (republishDiscovery ? `, republished ${configs} discovery config(s)` : '')
        );
    }
}

module.exports = StateResyncCoordinator;
