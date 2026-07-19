// @ts-check
'use strict';

const airconDecoder = require('./applicationDecoders/airconDecoder');
const { buildAirconRefresh } = require('./airconControlRegistry');
const { NEWLINE } = require('./constants');

/**
 * Decoded aircon reading produced by airconDecoder.decodeLine. The exact
 * fields vary by `kind`; only the ones this handler touches are listed.
 * @typedef {Object} AirconReading
 * @property {string} kind - 'temperature' | 'mode' | 'state' | 'action'
 * @property {string} network
 * @property {string} application
 * @property {string|null} [sourceUnit]
 * @property {string} [zoneGroup]
 * @property {string|null} [mode]
 * @property {*} [modeRaw]
 * @property {number|null} [errorCode]
 * @property {string} [errorDescription]
 * @property {number|null} [sensorStatus]
 */

/**
 * Handles C-Bus Air Conditioning (app 172) event lines, which C-Gate renders
 * as "[# ]aircon <verb> //PROJECT/<net>/<app> <params>" — a shape the standard
 * event parser can't handle (no group; often #-comment-prefixed). Gated behind
 * settings.cbus_aircon_app_id; when unset, returns false so these lines fall
 * through to the normal (comment-dropping) path, preserving current behaviour.
 * Returns true only when the line was decoded for the configured app and
 * consumed here; otherwise returns false so the line falls through to raw
 * event capture and the standard parser rather than being silently dropped.
 */
class AirconEventHandler {
    constructor({ registry, eventPublisher, logger, settings, getHaDiscovery, cbusname, sendCommand }) {
        this.registry = registry;
        this.eventPublisher = eventPublisher;
        this.logger = logger;
        this.settings = settings;
        // haDiscovery is initialized after the bridge constructor runs, so read it
        // live via an accessor to preserve the original late-binding behaviour.
        this.getHaDiscovery = getHaDiscovery;
        // C-Gate project name + command sink, used for AIRCON REFRESH requests.
        // Optional: without them no refresh is ever sent.
        this.cbusname = cbusname || null;
        this.sendCommand = typeof sendCommand === 'function' ? sendCommand : null;
        // Last warned plant error code per unit, for edge-triggered warn logging.
        this._lastErrorWarned = new Map();
        // Last warned temperature-sensor status per unit (same edge-triggered pattern).
        this._lastSensorWarned = new Map();
        // Zone groups ("wards") already sent an AIRCON REFRESH this session.
        // Once-per-session honours the spec's max-once-per-5-minutes (§25.8.3).
        this._refreshedWards = new Set();
    }

    /**
     * Whether a raw event line is native-aircon traffic (an `aircon <verb> ...`
     * line, optionally `#`-comment-prefixed), regardless of whether the feature
     * is enabled or the line can be decoded. Such lines are never valid
     * CBusEvents, so callers use this to avoid running them through the standard
     * parser (which would log a spurious "could not parse" warning).
     */
    isAirconLine(line) {
        let s = line.trim();
        if (s.startsWith('#')) s = s.slice(1).trim();
        return s.startsWith('aircon ');
    }

    handleLine(line) {
        const appId = this.settings.cbus_aircon_app_id;
        if (!appId) return false;
        if (!this.isAirconLine(line)) return false;
        // Aircon traffic and the feature is enabled — consume it here.
        const reading = /** @type {AirconReading|null} */ (airconDecoder.decodeLine(line));
        if (reading && reading.application === String(appId)) {
            const group = reading.sourceUnit || reading.zoneGroup;
            if (reading.kind === 'temperature' || reading.kind === 'mode' || reading.kind === 'state' || reading.kind === 'action') {
                this.eventPublisher.publishReading(reading.network, reading.application, group, reading);
            }
            // Remember ward/zones/type so HA can control this thermostat (writes
            // target ward+zone-list, not the source unit). See airconControlRegistry.
            if (reading.kind === 'mode') {
                this.registry.recordModeReading(reading);
            }
            // Event-driven HA discovery: announce the thermostat (keyed by source unit)
            // the first time we see it. ensureNativeAirconDiscovery is idempotent and
            // gated on ha_discovery_enabled internally.
            const haDiscovery = this.getHaDiscovery();
            if (haDiscovery && reading.sourceUnit) {
                haDiscovery.ensureNativeAirconDiscovery(reading.network, reading.application, reading.sourceUnit);
            }
            if (reading.kind === 'mode' && reading.mode === null) {
                this.logger.warn(
                    'Unmapped C-Bus HVAC mode code ' + reading.modeRaw +
                    ' on unit ' + reading.sourceUnit +
                    ' — please report. Line: ' + line
                );
            }
            if (reading.kind === 'action') {
                this._warnOnPlantError(reading);
            }
            if (reading.kind === 'temperature') {
                this._warnOnSensorFault(reading);
            }
            this._maybeRefreshWard(reading);
            return true;
        }
        // Recognisable aircon traffic, but we couldn't decode it or it targets a
        // different application. Don't consume it — let it fall through to raw
        // event capture and the standard parser instead of silently dropping it.
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`Aircon line not natively decoded (verb pending support): ${line}`);
        }
        return false;
    }

    /**
     * Warn on a non-zero HVAC plant error code (spec §25.6.5) — plant faults are
     * noteworthy. Edge-triggered per unit: logs only when the code changes, and
     * rearms when the plant reports no error (code 0) again.
     *
     * @param {Object} reading - Decoded 'action' reading from airconDecoder.
     * @private
     */
    _warnOnPlantError(reading) {
        if (reading.errorCode === null || reading.errorCode === undefined) return;
        const unit = reading.sourceUnit || reading.zoneGroup;
        const key = `${reading.network}/${reading.application}/${unit}`;
        if (reading.errorCode === 0) {
            this._lastErrorWarned.delete(key);
            return;
        }
        if (this._lastErrorWarned.get(key) === reading.errorCode) return;
        this._lastErrorWarned.set(key, reading.errorCode);
        this.logger.warn(
            `C-Bus HVAC plant error on unit ${unit}: ${reading.errorDescription} (code ${reading.errorCode})`
        );
    }

    /**
     * Warn on a degraded temperature sensor (spec §25.6.12: 2 = out of
     * calibration, 3 = total failure). Edge-triggered per unit like
     * _warnOnPlantError: logs only when the status changes, rearms below 2.
     *
     * @param {Object} reading - Decoded 'temperature' reading from airconDecoder.
     * @private
     */
    _warnOnSensorFault(reading) {
        if (reading.sensorStatus === null || reading.sensorStatus === undefined) return;
        const unit = reading.sourceUnit || reading.zoneGroup;
        const key = `${reading.network}/${reading.application}/${unit}`;
        if (reading.sensorStatus < 2) {
            this._lastSensorWarned.delete(key);
            return;
        }
        if (this._lastSensorWarned.get(key) === reading.sensorStatus) return;
        this._lastSensorWarned.set(key, reading.sensorStatus);
        const what = reading.sensorStatus >= 3 ? 'total failure' : 'out of calibration';
        this.logger.warn(
            `C-Bus HVAC temperature sensor on unit ${unit}: ${what} (status ${reading.sensorStatus})`
        );
    }

    /**
     * Mimic-device behaviour (§25.12.11 "send a Refresh as soon as practical
     * after start-up"): the first time a zone group is seen, ask its services
     * to broadcast their full state so learned state and HA entities settle
     * quickly instead of waiting for the periodic broadcast trickle. Sent at
     * most once per ward per session (§25.8.3 caps REFRESH at once per 5
     * minutes) and only when control is enabled, so read-only installs stay
     * purely passive listeners.
     *
     * @param {Object} reading - Any decoded aircon reading with a zoneGroup.
     * @private
     */
    _maybeRefreshWard(reading) {
        if (!this.settings.cbus_aircon_control_enabled) return;
        if (!this.sendCommand || !this.cbusname) return;
        const ward = reading.zoneGroup;
        if (!ward) return;
        const key = `${reading.network}/${reading.application}/${ward}`;
        if (this._refreshedWards.has(key)) return;
        this._refreshedWards.add(key);
        const cmd = buildAirconRefresh({
            cbusname: this.cbusname,
            network: reading.network,
            application: reading.application,
            ward
        });
        this.logger.info(`Requesting aircon state refresh for zone group ${ward} (${reading.network}/${reading.application})`);
        this.sendCommand(cmd + NEWLINE);
    }
}

module.exports = AirconEventHandler;
