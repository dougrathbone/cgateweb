'use strict';

const airconDecoder = require('./applicationDecoders/airconDecoder');

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
    constructor({ registry, eventPublisher, logger, settings, getHaDiscovery }) {
        this.registry = registry;
        this.eventPublisher = eventPublisher;
        this.logger = logger;
        this.settings = settings;
        // haDiscovery is initialized after the bridge constructor runs, so read it
        // live via an accessor to preserve the original late-binding behaviour.
        this.getHaDiscovery = getHaDiscovery;
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
        const reading = airconDecoder.decodeLine(line);
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
}

module.exports = AirconEventHandler;
