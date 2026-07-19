// @ts-check
'use strict';

const { EventEmitter } = require('events');

/**
 * Owns the bridge's lifecycle state machine and readiness reason. Computes
 * whether the bridge is "ready" (MQTT + event + a healthy command connection
 * all up) from a connection-state snapshot and runs the edge-triggered
 * lifecycle transition logic.
 *
 * Emits `readinessChanged` with `{ ready, reason }` on every `update()` call.
 * The bridge subscribes and performs the actual side effects (publishing the
 * `hello/cgateweb` status via mqttManager.setBridgeReady and refreshing the HA
 * bridge diagnostics). This mirrors the original `_updateBridgeReadiness`, which
 * fired those side effects on every invocation regardless of whether the
 * lifecycle state actually changed; the side effects are themselves idempotent
 * / individually edge-triggered downstream.
 */
class BridgeReadiness extends EventEmitter {
    constructor() {
        super();
        this._hasEverBeenReady = false;
        this._lifecycle = {
            state: 'booting',
            reason: 'startup',
            since: Date.now(),
            transitions: 0
        };
    }

    /**
     * Recomputes readiness from the supplied connection state, updates the
     * lifecycle state machine, and emits `readinessChanged`.
     *
     * @param {Object} connectionState
     * @param {boolean} connectionState.mqttConnected
     * @param {boolean} connectionState.eventConnected
     * @param {number} connectionState.healthyCommandConnections
     * @param {string} reason
     * @returns {{ ready: boolean, reason: string }}
     */
    update(connectionState, reason = 'state-change') {
        const ready = !!(
            connectionState.mqttConnected &&
            connectionState.eventConnected &&
            connectionState.healthyCommandConnections > 0
        );
        if (ready) {
            this._hasEverBeenReady = true;
            this.setLifecycleState('ready', reason);
        } else if (this._lifecycle.state !== 'stopping') {
            this.setLifecycleState(this._hasEverBeenReady ? 'degraded' : 'booting', reason);
        }
        this.emit('readinessChanged', { ready, reason });
        return { ready, reason };
    }

    setLifecycleState(state, reason) {
        if (this._lifecycle.state === state && this._lifecycle.reason === reason) return;
        if (this._lifecycle.state !== state) {
            this._lifecycle.transitions += 1;
        }
        this._lifecycle.state = state;
        this._lifecycle.reason = reason;
        this._lifecycle.since = Date.now();
    }

    /**
     * Returns a snapshot of the lifecycle state for inclusion in the bridge
     * status payload (web server /status and HA bridge diagnostics).
     */
    getLifecycleSnapshot() {
        return {
            state: this._lifecycle.state,
            reason: this._lifecycle.reason,
            since: this._lifecycle.since,
            transitions: this._lifecycle.transitions
        };
    }
}

module.exports = BridgeReadiness;
