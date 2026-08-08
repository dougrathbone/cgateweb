// @ts-check
'use strict';

const measurementDecoder = require('./applicationDecoders/measurementDecoder');
const { LINE_UNPARSED } = require('./applicationDecoders/appEventLine');

/**
 * Handles C-Bus Measurement Application (app 228 / $E4) event lines, which
 * C-Gate renders as "measurement data //PROJECT/<net>/<app>/<device>/<channel>
 * <value> <multiplier> <units>" (docs/Measurement Application.md §28.5.1.1) —
 * a 4-segment address the standard event parser (3-segment net/app/group)
 * can't handle. Gated behind settings.cbus_measurement_app_id; when unset,
 * returns false so these lines fall through to the normal (comment-dropping)
 * path, preserving current behaviour.
 */
class MeasurementEventHandler {
    constructor({ eventPublisher, logger, settings, getHaDiscovery }) {
        this.eventPublisher = eventPublisher;
        this.logger = logger;
        this.settings = settings;
        // haDiscovery is initialized after the bridge constructor runs, so read it
        // live via an accessor, matching AirconEventHandler/SecurityEventHandler.
        this.getHaDiscovery = getHaDiscovery;
    }

    /**
     * Whether a raw event line is native-measurement traffic (a "measurement
     * data ..." line, optionally `#`-comment-prefixed), regardless of whether
     * the feature is enabled or the line can be decoded. Such lines are never
     * valid CBusEvents, so callers use this to keep them out of the standard
     * parser.
     */
    isMeasurementLine(line) {
        return measurementDecoder.isMeasurementLine(line);
    }

    handleLine(line) {
        const appId = this.settings.cbus_measurement_app_id;
        if (!appId) return false;
        if (!this.isMeasurementLine(line)) return false;

        // Recognisable measurement traffic and the feature is enabled — decode it.
        const reading = measurementDecoder.decodeLine(line);
        if (reading && reading.application === String(appId)) {
            // No single "group" address exists for Measurement (device+channel
            // instead) — publishReading's topic base is built by simple string
            // interpolation, so passing "device/channel" here produces the
            // desired cbus/read/{net}/228/{device}/{channel}/... topic shape.
            this.eventPublisher.publishReading(
                reading.network,
                reading.application,
                `${reading.device}/${reading.channel}`,
                reading
            );

            const haDiscovery = this.getHaDiscovery();
            if (haDiscovery) {
                haDiscovery.ensureMeasurementDiscovery(reading.network, reading.application, reading.device, reading.channel, reading);
            }
            return true;
        }

        // Recognisable measurement traffic, but we couldn't decode it (unknown
        // unit code, malformed args) or it targets a different application.
        // Don't consume it — the bridge logs it as unparsed and keeps it out of
        // the standard parser.
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`Measurement line not natively decoded: ${line}`);
        }
        return LINE_UNPARSED;
    }
}

module.exports = MeasurementEventHandler;
