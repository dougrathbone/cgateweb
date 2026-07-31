// @ts-check
'use strict';

const securityDecoder = require('./applicationDecoders/securityDecoder');
const { buildSecurityStatusRequest } = require('./securityCommand');
const { NEWLINE } = require('./constants');

/**
 * User-facing wording for each panel trouble condition, in both senses. The
 * panel's own `_raised`/`_cleared` argument is deliberately not echoed into the
 * log line: the sense is already carried by the wording.
 */
const PANEL_TROUBLE_TEXT = {
    mains: { raised: 'Mains power failure', cleared: 'Mains power restored' },
    battery: { raised: 'Battery low', cleared: 'Battery restored' },
    tamper: { raised: 'Tamper detected', cleared: 'Tamper cleared' },
    panic: { raised: 'Panic activated', cleared: 'Panic cleared' },
    line: { raised: 'Phone line cut', cleared: 'Phone line restored' },
    arm_failed: { raised: 'Arm failed', cleared: 'Arm failure cleared' },
    fire: { raised: 'Fire alarm', cleared: 'Fire alarm cleared' }
};

/**
 * Decoded security reading produced by securityDecoder.decodeLine. The exact
 * fields vary by `kind`; only the ones this handler touches are listed.
 * @typedef {Object} SecurityReading
 * @property {string} kind - 'zone' | 'status_report_1' | 'status_report_2' | 'status_request' | system-state verbs
 * @property {string} network
 * @property {string} application
 * @property {string|null} [zone]
 * @property {string} [zoneState] - 'sealed' | 'unsealed' | 'open' | 'short'
 * @property {Array<{zone: number, state: string}>} [zones] - status reports only
 * @property {number|null} [armState] - status_report_1 only
 * @property {string|null} [armMode] - status_report_1/system_arm: 'disarmed'|'away'|'night'|'day'|'vacation'
 * @property {boolean} [tamperActive] - status_report_1 only
 * @property {boolean} [panicActive] - status_report_1 only
 * @property {number|null} [mode] - system_arm only
 * @property {string|null} [modeName] - system_arm only: 'disarmed'|'away'|'night'|'day'|'vacation'
 * @property {number|null} [report] - status_request only
 * @property {string|null} [detail] - detail-suffixed trouble verbs' free-text argument
 * @property {string} [condition] - panel_trouble only: 'mains'|'battery'|'tamper'|'panic'|'line'|'arm_failed'|'fire'
 * @property {boolean} [active] - panel_trouble only: true = raised, false = cleared
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
 * (arm_ready, system_arm, alarm_on/off, …) are decoded, logged and surfaced
 * to the Live Events stream only — no MQTT state.
 *
 * This handler also owns the status_request sync dedupe for the whole bridge:
 * every trigger (connect, first traffic, 762 sync-ok) routes through
 * {@link requestStatusSync} so the per-network Sets are shared.
 */
class SecurityEventHandler {
    constructor({ eventPublisher, logger, settings, getHaDiscovery, cbusname, sendCommand, onEventLog }) {
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
        // Live Events (SSE) fan-out, same entry shape as EventPublisher's
        // onEventLog ({ ts, network, app, group, level, type }). Optional.
        this.onEventLog = typeof onEventLog === 'function' ? onEventLog : null;
        // Per-network status_request dedupe: key "net/app" → { early, postSync }.
        // 'early' covers the connect and first-traffic triggers (whichever
        // fires first — the fallback for sessions where no 762 ever arrives,
        // e.g. a bridge restart on an already-synced network); 'postSync'
        // covers the 762 sync-ok trigger. At most one pair each per session.
        this._syncState = new Map();
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

    /**
     * Send the status_request report pair (1 = system state + zones 1-32,
     * 2 = zones 33-80) for a network, deduplicated per session. Security
     * panels do not answer lighting-style getall requests (spec §5.9), so
     * this is the only way to learn zone state up front. The request is
     * read-only — the panel only broadcasts its current state in reply.
     *
     * All triggers route here so the dedupe is shared:
     *   'connect' — BridgeInitializationService on ALL CONNECTED
     *   'traffic' — first security traffic seen on the network
     *   'sync'    — C-Gate 762 "Network sync ok" event
     * 'connect' and 'traffic' share one "early" slot (first one wins);
     * 'sync' has its own slot, so a post-sync refresh is always allowed once.
     *
     * @param {string|number} network - C-Bus network id.
     * @param {'connect'|'traffic'|'sync'} trigger - What prompted the request.
     * @returns {boolean} true when the request pair was actually sent.
     */
    requestStatusSync(network, trigger) {
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return false;
        if (!this.sendCommand || !this.cbusname) return false;
        if (network === null || network === undefined) return false;

        const key = `${network}/${appId}`;
        let state = this._syncState.get(key);
        if (!state) {
            state = { early: false, postSync: false };
            this._syncState.set(key, state);
        }
        if (trigger === 'sync') {
            if (state.postSync) return false;
            state.postSync = true;
        } else {
            if (state.early) return false;
            state.early = true;
        }

        for (const report of [1, 2]) {
            const cmd = buildSecurityStatusRequest({
                cbusname: this.cbusname,
                network,
                application: appId,
                report
            });
            this.sendCommand(cmd + NEWLINE);
        }
        this.logger.info(`Requested security zone status sync for network ${network} (${key}, trigger: ${trigger})`);
        return true;
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
                // DEBUG, not INFO: zone changes are routine traffic and would
                // fill the log over months on a busy panel (issue #42 feedback).
                if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                    this.logger.debug(`Security zone ${reading.network}/${reading.application}/${reading.zone}: ${reading.zoneState}`);
                }
                this._emitEventLog(reading.network, reading.application, reading.zone,
                    reading.zoneState === 'sealed' ? 0 : 255,
                    reading.zoneState === 'sealed' ? 'off' : 'on',
                    this._zoneLabel(reading.network, reading.zone),
                    `Zone ${reading.zoneState}`);
            } else if (reading.kind === 'status_report_1' || reading.kind === 'status_report_2') {
                for (const entry of reading.zones) {
                    this._publishZone(reading.network, reading.application, String(entry.zone), entry.state);
                }
                this._logStatusReportSummary(reading);
            } else if (reading.kind === 'status_request') {
                // Echo of our own request on the event port — consume quietly.
                if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                    this.logger.debug(`Security status_request echo (${reading.network}/${reading.application}, report ${reading.report})`);
                }
            } else {
                // System-state verbs (arm_ready, system_arm, alarm_on/off, …):
                // phase 2 material — no MQTT state, but log them human-readably
                // and surface them in the Live Events stream.
                this.logger.info(
                    `C-Bus Security: ${this._describeSystemEvent(reading)} (${reading.network}/${reading.application})`
                );
                this._emitSystemEventLog(reading);
            }
            if (reading.kind !== 'status_request') {
                this.requestStatusSync(reading.network, 'traffic');
            }
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
     * One DEBUG summary line per status report (counts per zone state, plus
     * the arm/tamper/panic prefix for report 1) instead of one line per zone.
     *
     * @param {SecurityReading} reading
     * @private
     */
    _logStatusReportSummary(reading) {
        if (!this.logger.isLevelEnabled || !this.logger.isLevelEnabled('debug')) return;
        const counts = { sealed: 0, unsealed: 0, open: 0, short: 0 };
        for (const entry of reading.zones) {
            if (Object.prototype.hasOwnProperty.call(counts, entry.state)) counts[entry.state]++;
        }
        const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`);
        let summary = `Security ${reading.kind} ${reading.network}/${reading.application}: ${reading.zones.length} zones (${parts.join(', ')})`;
        if (reading.kind === 'status_report_1') {
            summary += `; arm=${reading.armMode || reading.armState}, tamper=${reading.tamperActive ? 'active' : 'ok'}, panic=${reading.panicActive ? 'active' : 'ok'}`;
        }
        this.logger.debug(summary);
    }

    /**
     * Human-readable text for a system-state reading (logged at INFO).
     *
     * @param {SecurityReading} reading
     * @returns {string}
     * @private
     */
    _describeSystemEvent(reading) {
        switch (reading.kind) {
            case 'system_arm':
                if (reading.mode === 0) return 'System disarmed';
                return `System armed (${reading.modeName ? reading.modeName[0].toUpperCase() + reading.modeName.slice(1) : `mode ${reading.mode}`} mode)`;
            case 'arm_ready':
                return 'Ready to arm';
            case 'arm_not_ready':
                return `Zone ${reading.zone} open — not ready to arm`;
            case 'exit_delay_started':
                return 'Exit delay started';
            case 'zone_isolated':
                return `Zone ${reading.zone} bypassed`;
            case 'alarm_on':
                return 'Alarm on';
            case 'alarm_off':
                return 'Alarm off';
            case 'panel_trouble':
                return PANEL_TROUBLE_TEXT[reading.condition]
                    ? PANEL_TROUBLE_TEXT[reading.condition][reading.active ? 'raised' : 'cleared']
                    : reading.condition;
            default:
                return reading.kind;
        }
    }

    /**
     * Surface a system-state reading in the Live Events stream. Uses the zone
     * as the group when the verb carries one (arm_not_ready, zone_isolated),
     * otherwise null — the UI renders a group-less entry as net/app instead of
     * inventing a net/app/0 address that matches no real C-Bus object.
     * Level/type follow the on/off-ish verbs so the UI styling matches other
     * events; the description carries the human-readable text so the UI never
     * has to render a meaningless level percentage for a security event.
     *
     * @param {SecurityReading} reading
     * @private
     */
    _emitSystemEventLog(reading) {
        let level = 0;
        let type = 'update';
        if (reading.kind === 'alarm_on' || (reading.kind === 'system_arm' && reading.mode !== 0)) {
            level = 255;
            type = 'on';
        } else if (reading.kind === 'alarm_off' || (reading.kind === 'system_arm' && reading.mode === 0)) {
            type = 'off';
        }
        this._emitEventLog(reading.network, reading.application, reading.zone || null, level, type,
            reading.zone ? this._zoneLabel(reading.network, reading.zone) : null,
            this._describeSystemEvent(reading));
    }

    /**
     * Resolve a security zone's display label. Zone labels live under
     * application 1 in the Toolkit project (`{net}/1/{zone}` keys), while zone
     * events are keyed on the security app — the same cross-app lookup
     * discovery does. Returns null when no label is known.
     *
     * @param {string} network
     * @param {string} zone
     * @returns {string|null}
     * @private
     */
    _zoneLabel(network, zone) {
        const haDiscovery = this.getHaDiscovery();
        const labelMap = haDiscovery && haDiscovery.labelMap;
        if (!labelMap || typeof labelMap.get !== 'function') return null;
        return labelMap.get(`${network}/1/${zone}`) || null;
    }

    /**
     * Emit one Live Events (SSE) entry in the same shape EventPublisher uses
     * for lighting events ({ ts, network, app, group, level, type }), plus an
     * optional display label the UI prefers over its own label lookup and an
     * optional human-readable description. When a description is present the UI
     * shows it in place of the level percentage, because "0 (0%)" says nothing
     * useful about a zone unsealing or a system arming (issue #42 feedback).
     *
     * @private
     */
    _emitEventLog(network, application, group, level, type, label = null, description = null) {
        if (!this.onEventLog) return;
        this.onEventLog({
            ts: Date.now(), network, app: application, group, level, type,
            ...(label && { label }),
            ...(description && { description })
        });
    }
}

module.exports = SecurityEventHandler;
