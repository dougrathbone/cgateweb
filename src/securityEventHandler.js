// @ts-check
'use strict';

const securityDecoder = require('./applicationDecoders/securityDecoder');
const { buildSecurityStatusRequest } = require('./securityCommand');
const { NEWLINE } = require('./constants');

/**
 * Decoded security reading produced by securityDecoder.decodeLine. The exact
 * fields vary by `kind`; only the ones this handler touches are listed.
 * @typedef {Object} SecurityReading
 * @property {string} kind - 'zone' | 'status_report_1' | 'status_report_2' | system-state verbs
 * @property {string} network
 * @property {string} application
 * @property {string|null} [zone]
 * @property {string} [zoneState] - 'sealed' | 'unsealed' | 'open' | 'short'
 * @property {Array<{zone: number, state: string}>} [zones] - status reports only
 */

/**
 * Handles C-Bus Security (app 208) event lines, which C-Gate renders as
 * "[# ]security <verb> //PROJECT/<net>/<app>[/<zone>] <params>" — a shape the
 * standard event parser can't handle (no group-style payload; usually
 * `#`-comment-prefixed). Gated behind settings.cbus_security_app_id; when
 * unset (or '0'), returns false so these lines fall through to the normal
 * (comment-dropping) path, preserving current behaviour. Returns true only
 * when the line was decoded for the configured app and consumed here;
 * otherwise returns false so the line falls through to raw event capture
 * rather than being silently dropped.
 *
 * Phase 1 scope (zone sensors): zone_sealed/unsealed/open/short events and
 * status reports publish zone state; the remaining system-state verbs
 * (arm_ready, system_arm, alarm_on/off, …) are decoded and debug-logged only.
 */
class SecurityEventHandler {
    constructor({ eventPublisher, logger, settings, getHaDiscovery, cbusname, sendCommand }) {
        this.eventPublisher = eventPublisher;
        this.logger = logger;
        this.settings = settings;
        // haDiscovery is initialized after the bridge constructor runs, so read it
        // live via an accessor to preserve the original late-binding behaviour.
        this.getHaDiscovery = getHaDiscovery;
        // C-Gate project name + command sink, used for security status_request
        // initial sync. Optional: without them no request is ever sent.
        this.cbusname = cbusname || null;
        this.sendCommand = typeof sendCommand === 'function' ? sendCommand : null;
        // Networks already sent a status_request 1+2 this session.
        this._statusRequestedNetworks = new Set();
    }

    /**
     * Whether a raw event line is security-application traffic (a
     * `security <verb> ...` line, optionally `#`-comment-prefixed), regardless
     * of whether the feature is enabled or the line can be decoded. Such lines
     * are never valid CBusEvents, so callers use this to avoid running them
     * through the standard parser (which would publish a bogus OFF for zone
     * events or log a spurious "could not parse" warning for status reports).
     */
    isSecurityLine(line) {
        let s = line.trim();
        if (s.startsWith('#')) s = s.slice(1).trim();
        return s.startsWith('security ');
    }

    handleLine(line) {
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return false;
        if (!this.isSecurityLine(line)) return false;
        // Security traffic and the feature is enabled — consume it here.
        const reading = /** @type {SecurityReading|null} */ (securityDecoder.decodeLine(line));
        if (reading && reading.application === String(appId)) {
            if (reading.kind === 'zone') {
                this._publishZone(reading.network, reading.application, reading.zone, reading.zoneState);
            } else if (reading.kind === 'status_report_1' || reading.kind === 'status_report_2') {
                for (const entry of reading.zones) {
                    this._publishZone(reading.network, reading.application, String(entry.zone), entry.state);
                }
            } else {
                // System-state verbs (arm_ready, system_arm, alarm_on/off, …):
                // phase 2 material — decode and log only, no MQTT state.
                if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                    this.logger.debug(`C-Bus Security event: ${reading.kind} (${reading.network}/${reading.application})`);
                }
            }
            this._maybeRequestStatus(reading);
            return true;
        }
        // Recognisable security traffic, but we couldn't decode it or it
        // targets a different application. Don't consume it — let it fall
        // through to raw event capture instead of silently dropping it.
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`Security line not decoded (verb pending support): ${line}`);
        }
        return false;
    }

    /**
     * Publish one zone's state and trigger event-driven HA discovery for it.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} zone
     * @param {string} zoneState - 'sealed' | 'unsealed' | 'open' | 'short'
     * @private
     */
    _publishZone(network, application, zone, zoneState) {
        this.eventPublisher.publishReading(network, application, zone, { kind: 'security_zone', zoneState });
        // Event-driven HA discovery: announce the zone's binary_sensor the
        // first time we see it. ensureSecurityZoneDiscovery is idempotent and
        // gated on ha_discovery_enabled internally.
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.ensureSecurityZoneDiscovery(network, application, zone);
        }
    }

    /**
     * Initial zone-state sync: the first time security traffic is seen on a
     * network, ask the panel for both status reports so learned zone state and
     * HA entities settle quickly instead of waiting for zone events (which can
     * be rare). Security panels do not answer lighting-style getall requests
     * (spec §5.9). Sent at most once per network per session; the request is
     * read-only — the panel only broadcasts its current state in reply.
     *
     * @param {SecurityReading} reading - Any decoded security reading.
     * @private
     */
    _maybeRequestStatus(reading) {
        if (!this.sendCommand || !this.cbusname) return;
        const key = `${reading.network}/${reading.application}`;
        if (this._statusRequestedNetworks.has(key)) return;
        this._statusRequestedNetworks.add(key);
        for (const report of [1, 2]) {
            const cmd = buildSecurityStatusRequest({
                cbusname: this.cbusname,
                network: reading.network,
                application: reading.application,
                report
            });
            this.sendCommand(cmd + NEWLINE);
        }
        this.logger.info(`Requested security zone status sync for network ${reading.network} (${reading.network}/${reading.application})`);
    }
}

module.exports = SecurityEventHandler;
