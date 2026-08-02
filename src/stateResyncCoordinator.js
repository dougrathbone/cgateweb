// @ts-check
'use strict';

/**
 * Triggers that also need the retained HA Discovery configs replayed, not just
 * state. A broker restart without persistence drops the configs, so the entities
 * are gone rather than merely stale; a Home Assistant restart leaves the broker
 * untouched, so its retained configs are still there to be re-read.
 */
const TRIGGERS_NEEDING_DISCOVERY_REPUBLISH = new Set(['mqtt-reconnect']);

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
     * @param {ReturnType<typeof import('./logger').createLogger>} deps.logger
     * @param {() => (Object|null)} deps.getHaDiscovery - late-bound: haDiscovery is built after the bridge constructor
     * @param {() => ({ sendGetallLevels: Function, sendSecurityStatusRequests: Function }|null)} deps.getInitializationService
     *   late-bound: the coordinator is built in _buildSubsystems, which runs
     *   before the bridge assigns its initializationService. Taking the service
     *   by value there captured undefined and threw on every resync (issue #44).
     */
    constructor({ settings, logger, getHaDiscovery, getInitializationService }) {
        this.settings = settings;
        this.logger = logger;
        this.getHaDiscovery = getHaDiscovery;
        this.getInitializationService = getInitializationService;

        /** @type {NodeJS.Timeout|null} */
        this._pending = null;
        // Triggers collapsed into the pending resync. Also the sticky record of
        // whether any of them needed the discovery configs replayed.
        /** @type {Set<string>} */
        this._pendingTriggers = new Set();
    }

    /**
     * Request a resync. Repeated calls inside the debounce window collapse into
     * one.
     *
     * @param {'ha-birth'|'mqtt-reconnect'|string} trigger
     * @returns {boolean} true when a resync is now pending
     */
    requestResync(trigger) {
        if (!this._triggerEnabled(trigger)) {
            this.logger.debug(`State resync trigger '${trigger}' is disabled by settings`);
            return false;
        }

        this._pendingTriggers.add(trigger);

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
        const pendingTriggers = [...this._pendingTriggers];
        const triggers = pendingTriggers.join(', ');
        const republishDiscovery = pendingTriggers.some((t) => TRIGGERS_NEEDING_DISCOVERY_REPUBLISH.has(t));
        this._pendingTriggers.clear();

        const initializationService = this.getInitializationService();
        if (!initializationService) {
            // Resync runs from a timer, so anything thrown here is an uncaught
            // exception that takes the whole bridge down. Skipping a refresh is
            // recoverable; dying is not.
            this.logger.warn(`State resync (${triggers}) skipped: initialization service unavailable`);
            return;
        }

        let configs = 0;
        if (republishDiscovery) {
            const haDiscovery = this.getHaDiscovery();
            if (haDiscovery) configs = haDiscovery.republishDiscoveryConfigs();
        }

        // 'bulk' priority: a resync can be dozens of commands, and it fires
        // exactly when someone is likely pressing switches (they just restarted
        // HA). Startup's getall gets away with normal priority because nothing
        // competes with it; here a user command must not queue behind the flood.
        const netapps = initializationService.sendGetallLevels(null, { priority: 'bulk' });

        // Security panels do not answer lighting-style getall (spec §5.9), so the
        // zone sensors need their own status_request pair or they would go stale
        // across exactly the restart this coordinator exists to fix. This is
        // resolved from ha_discovery_networks, not from the getall pairs: the
        // security app is deliberately absent from those, so an install with
        // ha_discovery_networks set but no getall_networks still resyncs zones.
        initializationService.sendSecurityStatusRequests('resync');

        if (netapps.length === 0) {
            this.logger.debug(
                `State resync (${triggers}) had no getall networks configured, so no levels were requested`
            );
            return;
        }

        this.logger.info(
            `State resync (${triggers}): requested levels for ${netapps.length} network/app pair(s)` +
            (republishDiscovery ? `, republished ${configs} discovery config(s)` : '')
        );
    }
}

module.exports = StateResyncCoordinator;
