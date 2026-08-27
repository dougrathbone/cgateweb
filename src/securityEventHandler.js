// @ts-check
'use strict';

const securityDecoder = require('./applicationDecoders/securityDecoder');
const { isAppEventLine, LINE_UNPARSED } = require('./applicationDecoders/appEventLine');
const { securityZoneLabelKey } = require('./securityZoneLabels');
const SecurityPanelState = require('./securityPanelState');
const { buildSecurityStatusRequest, buildSecurityRequestZoneName } = require('./securityCommand');
const { redactCgateLine } = require('./utils');
const { NEWLINE } = require('./constants');
const { describePanelCondition } = require('./securityPanelConditions');
const fs = require('fs');

/**
 * Which dedupe slot each status-sync trigger consumes. 'resync' has no slot: a
 * Home Assistant or broker restart can happen any number of times in one bridge
 * session and each one genuinely needs the zone state resent, so it is exempt
 * from the once-per-session dedupe. Rate limiting for that trigger is the resync
 * coordinator's debounce instead.
 */
const SYNC_TRIGGER_SLOTS = {
    connect: 'early',
    traffic: 'early',
    sync: 'postSync',
    resync: null
};

const SYNC_EXEMPT_KINDS = new Set([
    'status_request', 'arm_command_echo', 'keypad_command_echo',
    'zone_name_request_echo', 'zone_name', 'password_entry'
]);

/** MQTT / Home Assistant sensor state is capped at 255 characters. */
const BYPASSED_ZONES_STATE_MAX = 255;
const BYPASSED_ZONES_NONE = 'none';

/**
 * Comma-separated zone names for the bypassed-zones sensor, or "none".
 * Truncates to the MQTT state limit; the full lists ride attributes.
 *
 * @param {string[]} names
 * @returns {string}
 */
function formatBypassedZoneState(names) {
    if (!names || names.length === 0) return BYPASSED_ZONES_NONE;
    const joined = names.join(', ');
    if (joined.length <= BYPASSED_ZONES_STATE_MAX) return joined;
    return `${joined.slice(0, BYPASSED_ZONES_STATE_MAX - 3)}...`;
}

/**
 * Dispatch table for decoded security readings. Unknown kinds fall through to
 * the system-state path (alarm panel + Live Events).
 */
const LINE_KIND_HANDLERS = {
    zone(handler, reading) {
        handler._publishZone(reading.network, reading.application, reading.zone, reading.zoneState);
        handler._maybeRequestZoneName(reading.network, reading.application, reading.zone);
        // DEBUG, not INFO: zone changes are routine traffic and would
        // fill the log over months on a busy panel (issue #42 feedback).
        if (handler.logger.isLevelEnabled && handler.logger.isLevelEnabled('debug')) {
            handler.logger.debug(`Security zone ${reading.network}/${reading.application}/${reading.zone}: ${reading.zoneState}`);
        }
        handler._emitEventLog(reading.network, reading.application, reading.zone,
            reading.zoneState === 'sealed' ? 0 : 255,
            reading.zoneState === 'sealed' ? 'off' : 'on',
            handler._zoneLabel(reading.network, reading.zone),
            `Zone ${reading.zoneState}`);
    },

    zone_name(handler, reading) {
        handler._applyZoneName(reading);
    },

    zone_name_request_echo(handler, reading) {
        if (handler.logger.isLevelEnabled && handler.logger.isLevelEnabled('debug')) {
            handler.logger.debug(`Security zone_name request echo (${reading.network}/${reading.application}, zone ${reading.zone})`);
        }
    },

    password_entry(handler, reading) {
        handler._publishPasswordEntry(reading);
    },

    status_report_1(handler, reading) {
        handler._applyStatusReport(reading);
    },

    status_report_2(handler, reading) {
        handler._applyStatusReport(reading);
    },

    panel_trouble(handler, reading) {
        handler._publishPanelChanges(reading.network, reading.application,
            handler.panelState.applyReading(reading));
        handler._logSystemEvent(reading);
    },

    status_request(handler, reading) {
        if (handler.logger.isLevelEnabled && handler.logger.isLevelEnabled('debug')) {
            handler.logger.debug(`Security status_request echo (${reading.network}/${reading.application}, report ${reading.report})`);
        }
    },

    keypad_command_echo(handler, reading) {
        if (handler.logger.isLevelEnabled && handler.logger.isLevelEnabled('debug')) {
            handler.logger.debug(`Security keypad echo (${reading.network}/${reading.application})`);
        }
    },

    arm_command_echo(handler, reading) {
        if (handler.logger.isLevelEnabled && handler.logger.isLevelEnabled('debug')) {
            handler.logger.debug(`Security arm echo (${reading.network}/${reading.application}, mode ${reading.mode})`);
        }
    },

    system_arm(handler, reading) {
        handler._publishPanelChanges(reading.network, reading.application,
            handler.panelState.applyReading(reading));
        if (reading.mode === 0) {
            handler._clearZoneIsolation(reading.network, reading.application);
        }
        handler._handleSystemStateVerb(reading);
    },

    zone_isolated(handler, reading) {
        handler._markZoneIsolated(reading.network, reading.application, reading.zone);
        handler._handleSystemStateVerb(reading);
    }
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
 * @property {string} [name] - zone_name only
 * @property {number|null} [code] - password_entry only: 1-4, or null when unrecognised
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
 * Zone events and status reports publish zone state; panel_trouble readings
 * and system_arm update the panel condition sensors (see securityPanelState);
 * zone_isolated adds an `isolated` attribute to the zone it names (cleared for
 * the whole network on the next disarm) and updates the panel's bypassed-zones
 * list sensor; the remaining system-state verbs
 * (arm_ready, exit_delay_started, …) are decoded, logged and surfaced to the
 * Live Events stream only. Arm and disarm writes live on the MQTT command
 * router (security arm, emulate_keypad), not in this handler.
 *
 * This handler also owns the status_request sync dedupe for the whole bridge:
 * every trigger (connect, first traffic, 762 sync-ok) routes through
 * {@link requestStatusSync} so the per-network Sets are shared.
 */
class SecurityEventHandler {
    constructor({ eventPublisher, logger, settings, getHaDiscovery, cbusname, sendCommand, onEventLog, panelStateFile = null }) {
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
        // Zones we have already asked C-Gate to name this session (do not fire
        // a request per event, and never a bulk 80-zone dump on connect).
        this._zoneNameRequested = new Set();
        // Panel-wide trouble conditions, so repeated verbs don't republish.
        this.panelState = new SecurityPanelState();
        // The panel offers no way to query mains/battery/line/arm-fail/fire,
        // so the condition state is persisted here across restarts (#42);
        // null disables persistence (e.g. no writable path).
        this._panelStateFile = panelStateFile;
        if (this._panelStateFile) this._loadPanelState();
    }

    /**
     * Load a previously persisted panel-state snapshot, if any. A missing file
     * is normal (first run); a corrupt one is a warning, never fatal.
     * @private
     */
    _loadPanelState() {
        try {
            const raw = fs.readFileSync(this._panelStateFile, 'utf8');
            this.panelState.restore(JSON.parse(raw));
            this.logger.info(`Restored security panel state from ${this._panelStateFile}`);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.logger.warn(`Could not read security panel state file (${err.message}); starting fresh`);
            }
        }
    }

    /**
     * Persist the panel-state snapshot. Best-effort: a write failure is a
     * warning, never fatal to event handling.
     * @private
     */
    _persistPanelState() {
        if (!this._panelStateFile) return;
        try {
            fs.writeFileSync(this._panelStateFile, JSON.stringify(this.panelState.toJSON(), null, 2));
        } catch (err) {
            this.logger.warn(`Could not write security panel state file (${err.message})`);
        }
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
        return isAppEventLine(line, 'security');
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
     * @param {'connect'|'traffic'|'sync'|'resync'} trigger - What prompted the request.
     * @returns {boolean} true when the request pair was actually sent.
     */
    requestStatusSync(network, trigger) {
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return false;
        if (!this.sendCommand || !this.cbusname) return false;
        if (network === null || network === undefined) return false;

        if (!Object.prototype.hasOwnProperty.call(SYNC_TRIGGER_SLOTS, trigger)) {
            // Fail loudly rather than consuming a dedupe slot: silently burning
            // the 'early' slot on a typo would suppress the real connect/traffic
            // sync for the rest of the session.
            this.logger.warn(`Unknown security status-sync trigger '${trigger}'; ignoring`);
            return false;
        }

        const key = `${network}/${appId}`;
        let state = this._syncState.get(key);
        if (!state) {
            state = { early: false, postSync: false };
            this._syncState.set(key, state);
        }
        const slot = SYNC_TRIGGER_SLOTS[trigger];
        if (slot) {
            if (state[slot]) return false;
            state[slot] = true;
        }

        // A sync exists to reseed consumers that have lost state, so the report
        // it provokes must publish even when nothing has changed. Without this
        // the transition dedupe swallows it and Home Assistant's alarm card
        // stays blank after a restart (#51). Not done for 'traffic', which is
        // routine panel activity, not a request to resend.
        if (trigger !== 'traffic') {
            this.panelState.forgetAlarmState(network);
            // Panel trouble sensors and the bypassed-zones list are unqueryable
            // (not in status_report), so a Home Assistant restart would leave
            // them Unknown unless we republish the last known values (#62).
            this._republishPersistedDiagnostics(String(network), String(appId));
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
            const kindHandler = LINE_KIND_HANDLERS[reading.kind] || ((h, r) => h._handleSystemStateVerb(r));
            kindHandler(this, reading);
            if (!SYNC_EXEMPT_KINDS.has(reading.kind)) {
                this.requestStatusSync(reading.network, 'traffic');
            }
            return true;
        }
        // Recognisable security traffic, but we couldn't decode it or it
        // targets a different application. Don't consume it — the bridge logs
        // it as unparsed and keeps it out of the standard parser.
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`Security line not decoded (verb pending support): ${redactCgateLine(line)}`);
        }
        return LINE_UNPARSED;
    }

    /**
     * Apply a status-report reading: optional isolation clear on disarm,
     * per-zone publishes, and report-1 panel/alarm seeding.
     * @param {SecurityReading} reading
     * @private
     */
    _applyStatusReport(reading) {
        if (reading.kind === 'status_report_1' && reading.armState === 0) {
            this._clearZoneIsolation(reading.network, reading.application,
                new Set(reading.zones.map((entry) => String(entry.zone))));
        }
        for (const entry of reading.zones) {
            this._publishZone(reading.network, reading.application, String(entry.zone), entry.state);
        }
        if (reading.kind === 'status_report_1') {
            this._publishPanelChanges(reading.network, reading.application,
                this.panelState.seedFromStatusReport(reading));
            this._publishAlarmTransition(reading.network, reading.application, reading);
        }
        this._logStatusReportSummary(reading);
    }

    /**
     * Alarm-panel transition plus Live Events for system-state verbs.
     * @param {SecurityReading} reading
     * @private
     */
    _handleSystemStateVerb(reading) {
        this._publishAlarmTransition(reading.network, reading.application, reading);
        this._logSystemEvent(reading);
    }

    /**
     * @param {SecurityReading} reading
     * @private
     */
    _logSystemEvent(reading) {
        const description = this._describeSystemEvent(reading);
        this.logger.info(
            `C-Bus Security: ${description} (${reading.network}/${reading.application})`
        );
        this._emitSystemEventLog(reading, description);
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
        // Remembered so a later isolation change can re-render this zone's
        // attributes without dropping zone_state (the attributes topic is a
        // whole-document replace in Home Assistant).
        this.panelState.noteZoneState(network, zone, zoneState);
        this._publishZoneReading(network, application, zone, zoneState);
    }

    /**
     * Publish one zone's state + attributes for a known state, folding in the
     * zone's current isolation, and make sure its binary_sensor exists.
     *
     * Split out from _publishZone because isolation changes have to republish a
     * zone from the *remembered* state rather than a freshly reported one, and
     * both routes must agree on the payload and on announcing the entity — an
     * isolation announced for a zone we have never published would otherwise
     * land on a topic no entity is subscribed to.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} zone
     * @param {string|null} zoneState - null when the zone's state is not yet known.
     * @private
     */
    _publishZoneReading(network, application, zone, zoneState) {
        // The isolated flag is only added when set: the common reading object
        // then stays exactly what it has always been, and EventPublisher's
        // pre-rendered non-isolated payloads stay the common path.
        const reading = { kind: 'security_zone', zoneState };
        if (this.panelState.isZoneIsolated(network, zone)) reading.isolated = true;
        this.eventPublisher.publishReading(network, application, zone, reading);
        // Event-driven HA discovery: announce the zone's binary_sensor the
        // first time we see it. ensureSecurityZoneDiscovery is idempotent and
        // gated on ha_discovery_enabled internally.
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.ensureSecurityZoneDiscovery(network, application, zone);
        }
    }

    /**
     * Record a zone the panel isolated and publish the change. Repeats are
     * dropped by the tracker, so a panel re-announcing the same bypass costs
     * nothing.
     *
     * @param {string} network
     * @param {string} application
     * @param {string|null|undefined} zone
     * @private
     */
    _markZoneIsolated(network, application, zone) {
        if (zone === null || zone === undefined) return;
        if (!this.panelState.setZoneIsolated(network, zone)) return;
        this._publishZoneReading(network, application, zone, this.panelState.lastZoneState(network, zone));
        this._publishBypassedZones(network, application);
        this._persistPanelState();
    }

    /**
     * Clear isolation for every zone on a network and republish each one, so no
     * zone can be left advertising a bypass that ended.
     *
     * The republish is what makes the clear visible: the panel sends no
     * per-zone "isolation over" event, so nothing else would ever overwrite a
     * retained `"isolated":true` payload until that zone next changed state —
     * which for an internal door on a disarmed system can be days.
     *
     * @param {string} network
     * @param {string} application
     * @param {Set<string>|null} [zonesPublishedSeparately] - zones the caller is
     *   about to publish itself (a status report's own zone list). They are
     *   cleared like any other, but skipped here so the report's fresher state
     *   is the only thing that lands on their attributes topic.
     * @private
     */
    _clearZoneIsolation(network, application, zonesPublishedSeparately = null) {
        const cleared = this.panelState.clearZoneIsolation(network);
        if (cleared.length === 0) return;
        for (const { zone, zoneState } of cleared) {
            if (zonesPublishedSeparately && zonesPublishedSeparately.has(zone)) continue;
            this._publishZoneReading(network, application, zone, zoneState);
        }
        this._publishBypassedZones(network, application);
        this.logger.info(`C-Bus Security: zone isolation cleared for ${cleared.length} zone(s) (${network}/${application})`);
        this._persistPanelState();
    }

    /**
     * Ask C-Gate for a zone's name the first time we see the zone without a
     * Toolkit application-1 label. Not fired on connect (that would dump 80
     * requests); repeats are dropped for the rest of the session.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} zone
     * @private
     */
    _maybeRequestZoneName(network, application, zone) {
        if (!this.sendCommand || !this.cbusname) return;
        if (zone === null || zone === undefined) return;
        const zoneNum = parseInt(String(zone), 10);
        if (!Number.isInteger(zoneNum) || zoneNum < 1 || zoneNum > 127) return;

        const requestKey = `${network}/${application}/${zone}`;
        if (this._zoneNameRequested.has(requestKey)) return;

        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery && haDiscovery.labelMap && haDiscovery.labelMap.get(securityZoneLabelKey(network, zone))) {
            this._zoneNameRequested.add(requestKey);
            return;
        }

        this._zoneNameRequested.add(requestKey);
        const cmd = buildSecurityRequestZoneName({
            cbusname: this.cbusname,
            network,
            application,
            zone
        });
        this.sendCommand(cmd + NEWLINE);
    }

    /**
     * Apply a zone_name reading: store it as an application-1 label when none
     * exists yet, and re-announce the HA entity so the name reaches Home
     * Assistant.
     *
     * @param {SecurityReading} reading
     * @private
     */
    _applyZoneName(reading) {
        if (!reading.zone || !reading.name) return;
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery && typeof haDiscovery.applySecurityZoneName === 'function') {
            haDiscovery.applySecurityZoneName(reading.network, reading.zone, reading.name);
        }
        if (this.panelState.isZoneIsolated(reading.network, reading.zone)) {
            this._publishBypassedZones(reading.network, reading.application);
        }
    }

    /**
     * Publish a password-entry code onto the panel device as a diagnostic
     * MQTT value. Codes outside 1–4 are consumed quietly (fail closed).
     *
     * @param {SecurityReading} reading
     * @private
     */
    _publishPasswordEntry(reading) {
        if (reading.code === null || reading.code === undefined) return;
        this.eventPublisher.publishReading(reading.network, reading.application, 'panel', {
            kind: 'security_password_entry',
            code: reading.code
        });
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.ensureSecurityPanelDiscovery(reading.network, reading.application);
        }
    }

    /**
     * Track the HA alarm_control_panel state for one reading and publish any
     * transition through the shared reading path (cbus/read/{net}/{app}/panel/
     * state + attributes). Repeats dedupe inside the tracker.
     *
     * @param {string} network
     * @param {string} application
     * @param {SecurityReading} reading
     * @private
     */
    _publishAlarmTransition(network, application, reading) {
        const transition = this.panelState.applyAlarmReading(reading);
        if (!transition) return;
        this.eventPublisher.publishReading(network, application, 'panel', {
            kind: 'security_alarm',
            alarmState: transition.state,
            blockingZone: transition.blockingZone
        });
    }

    /**
     * Publish changed panel trouble conditions and make sure the panel's
     * entities exist. Discovery runs even when nothing changed, so a healthy
     * panel still gets its seven sensors seeded to OFF on first traffic rather
     * than waiting for its first fault.
     *
     * @param {string} network
     * @param {string} application
     * @param {Array<{condition: string, active: boolean}>} changes
     * @private
     */
    _publishPanelChanges(network, application, changes) {
        const haDiscovery = this.getHaDiscovery();
        const justAnnounced = haDiscovery && haDiscovery.ensureSecurityPanelDiscovery(network, application);
        // On the first announce, publish all seven so none sits Unknown in HA.
        // Callers always fold their reading into the tracker before calling, so
        // the seed is a superset of `changes` rather than a competing view.
        const toPublish = justAnnounced ? this.panelState.initialStates(network) : changes;
        for (const { condition, active } of toPublish) {
            this._publishPanelCondition(network, application, condition, active);
        }
        if (justAnnounced) this._publishBypassedZones(network, application);
        // Every panel-state change funnels through here (trouble verbs, disarm
        // clears, status-report seeds), so this is the one persist point.
        this._persistPanelState();
    }

    /**
     * @param {string} network
     * @param {string} application
     * @param {string} condition
     * @param {boolean} active
     * @private
     */
    _publishPanelCondition(network, application, condition, active) {
        this.eventPublisher.publishReading(network, application, `panel/${condition}`, {
            kind: 'security_panel', active
        });
    }

    /**
     * Re-seed panel diagnostics Home Assistant cannot recover from a status
     * report: trouble binary_sensors (mains, battery, ...) and the bypassed
     * zones list. Called on connect/sync/resync, not on routine traffic.
     *
     * @param {string} network
     * @param {string} application
     * @private
     */
    _republishPersistedDiagnostics(network, application) {
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery && typeof haDiscovery.ensureSecurityPanelDiscovery === 'function') {
            haDiscovery.ensureSecurityPanelDiscovery(network, application);
        }
        for (const { condition, active } of this.panelState.initialStates(network)) {
            this._publishPanelCondition(network, application, condition, active);
        }
        this._publishBypassedZones(network, application);
    }

    /**
     * Publish the panel's bypassed-zones list for dashboards (#62).
     *
     * @param {string} network
     * @param {string} application
     * @private
     */
    _publishBypassedZones(network, application) {
        const zones = this.panelState.isolatedZoneIds(network);
        const names = zones.map((zone) => this._zoneDisplayName(network, zone));
        this.eventPublisher.publishReading(network, application, 'panel/bypassed_zones', {
            kind: 'security_bypassed_zones',
            state: formatBypassedZoneState(names),
            zones,
            names
        });
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery && typeof haDiscovery.ensureSecurityPanelDiscovery === 'function') {
            haDiscovery.ensureSecurityPanelDiscovery(network, application);
        }
    }

    /**
     * Toolkit application-1 label for a zone, or "Zone N" when unnamed.
     *
     * @param {string} network
     * @param {string} zone
     * @returns {string}
     * @private
     */
    _zoneDisplayName(network, zone) {
        const haDiscovery = this.getHaDiscovery();
        const labelMap = haDiscovery && haDiscovery.labelMap;
        const labelled = labelMap && labelMap.get(securityZoneLabelKey(network, zone));
        return labelled || `Zone ${zone}`;
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
            case 'entry_delay_started':
                // Named zone when the panel gives one — during an entry delay
                // "which door was it" is the first thing anyone asks.
                return reading.zone
                    ? `Entry delay started (zone ${reading.zone})`
                    : 'Entry delay started';
            case 'zone_isolated':
                return `Zone ${reading.zone} bypassed`;
            case 'alarm_on':
                return 'Alarm on';
            case 'alarm_off':
                return 'Alarm off';
            case 'panel_trouble':
                return describePanelCondition(reading.condition, reading.active === true);
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
     * @param {string} description - Human-readable text from _describeSystemEvent
     *   (computed once by the caller for the INFO log and reused here).
     * @private
     */
    _emitSystemEventLog(reading, description) {
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
            description);
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
        return labelMap.get(securityZoneLabelKey(network, zone)) || null;
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
