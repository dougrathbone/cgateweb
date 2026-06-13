const { createLogger } = require('./logger');

/**
 * Tracks the C-Bus network *interface* (CNI / PCI) connectivity per network,
 * derived from C-Gate `GET //PROJECT/<net> InterfaceState` / `State` responses.
 *
 * Why this exists: C-Gate keeps its TCP link to cgateweb up even when the link
 * between C-Gate and the C-Bus network (the CNI/PCI) drops — so a socket-level
 * health check cannot see a CNI outage. C-Gate exposes it on the network object:
 *   InterfaceState = running                       → CNI connected (healthy)
 *   InterfaceState = opening|closing|closed|streamsclosed → down / recovering
 * (corroborated by State = ok vs new|sync). See docs and C-Gate event codes
 * 754/755/757/911 ("Can't open: C-Bus interface ... :<cni-ip>:10001").
 */
const RUNNING_STATE = 'running';

class NetworkInterfaceMonitor {
    /**
     * @param {Object} [opts]
     * @param {Object} [opts.logger]
     * @param {Function} [opts.now] - injectable clock for tests (returns ms)
     */
    constructor({ logger, now } = {}) {
        this.logger = logger || createLogger({ component: 'NetworkInterfaceMonitor' });
        this._now = now || (() => Date.now());
        // networkId(string) -> { interfaceState, state, online, since, lastChecked }
        this._networks = new Map();
    }

    /**
     * Record an InterfaceState/State reading for a network. Logs transitions
     * (online↔offline) so a CNI dropout shows up in the bridge logs as well as
     * the status page.
     *
     * @param {string|number} networkId
     * @param {{interfaceState?: string, state?: string}} reading
     */
    update(networkId, reading = {}) {
        const id = String(networkId);
        const ts = this._now();
        const prev = this._networks.get(id) || {
            interfaceState: null, state: null, online: null, since: ts, lastChecked: ts
        };
        const next = { ...prev, lastChecked: ts };

        if (reading.interfaceState !== undefined && reading.interfaceState !== null) {
            next.interfaceState = String(reading.interfaceState);
        }
        if (reading.state !== undefined && reading.state !== null) {
            next.state = String(reading.state);
        }

        // Online is determined by InterfaceState; if we've only ever seen a
        // State reading, leave the previous online verdict untouched.
        const online = next.interfaceState === null ? prev.online : (next.interfaceState === RUNNING_STATE);
        const wasOnline = prev.online;
        next.online = online;

        if (online !== wasOnline) {
            next.since = ts;
            if (online === false) {
                this.logger.warn(
                    `C-Bus network ${id} interface DOWN (InterfaceState=${next.interfaceState}) — ` +
                    'the CNI/PCI link between C-Gate and the C-Bus network has dropped.'
                );
            } else if (online === true && wasOnline === false) {
                this.logger.info(`C-Bus network ${id} interface restored (InterfaceState=${next.interfaceState}).`);
            }
        }

        this._networks.set(id, next);
    }

    /**
     * @returns {Array<{network:string, interfaceState:?string, state:?string, online:?boolean, since:number, lastChecked:number}>}
     */
    getSnapshot() {
        return [...this._networks.entries()].map(([network, v]) => ({
            network,
            interfaceState: v.interfaceState,
            state: v.state,
            online: v.online,
            since: v.since,
            lastChecked: v.lastChecked
        }));
    }

    /** True if any tracked network's interface is known to be down. */
    hasOutage() {
        return [...this._networks.values()].some(v => v.online === false);
    }
}

module.exports = { NetworkInterfaceMonitor, RUNNING_STATE };
