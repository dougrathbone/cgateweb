// @ts-check
'use strict';

const measurementDecoder = require('./applicationDecoders/measurementDecoder');
const { LINE_UNPARSED } = require('./applicationDecoders/appEventLine');
const { redactCgateLine } = require('./utils');

/**
 * Handles C-Bus Measurement Application (app 228 / $E4) event lines, which
 * C-Gate renders as "measurement data //PROJECT/<net>/<app>/<device>/<channel>
 * <value> <multiplier> <units>" (docs/Measurement Application.md §28.5.1.1) —
 * a 4-segment address the standard event parser (3-segment net/app/group)
 * can't handle.
 *
 * Decoding is gated behind settings.cbus_measurement_app_id, but recognising
 * the line is not. Unlike aircon and security traffic, a measurement broadcast
 * is not `#`-comment-prefixed, so with the feature off it does not land on the
 * bridge's comment-dropping branch - it reaches CBusEvent, which reads the
 * 4-segment address as a 3-segment one and the raw value as a lighting level.
 * A 22.06 degree sensor then publishes ON at 865%. So these lines are always
 * claimed, and the setting only decides whether they are decoded.
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
        // Classified BEFORE the enabled check, deliberately. A measurement
        // line is never a valid standard event, so it must be kept out of the
        // parser whether or not we can decode it (see the class note).
        if (!this.isMeasurementLine(line)) return false;

        const appId = this.settings.cbus_measurement_app_id;
        if (!appId) {
            this._warnFeatureOffOnce(line);
            return LINE_UNPARSED;
        }

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
            this.logger.debug(`Measurement line not natively decoded: ${redactCgateLine(line)}`);
        }
        return LINE_UNPARSED;
    }

    /**
     * Tell the user once that measurement traffic is on the bus but not being
     * decoded. Before this, the symptom was a nonsense lighting level rather
     * than anything naming the feature, which is not a hint anyone could act
     * on (reported on #60).
     *
     * Once per network/application, not once per line: a measurement device
     * broadcasts continuously and this is INFO, not debug.
     *
     * @param {string} line
     * @private
     */
    _warnFeatureOffOnce(line) {
        const reading = measurementDecoder.decodeLine(line);
        const key = reading ? `${reading.network}/${reading.application}` : 'unknown';
        if (!this._featureOffSeen) this._featureOffSeen = new Set();
        if (this._featureOffSeen.has(key)) return;
        this._featureOffSeen.add(key);
        this.logger.info(
            `C-Bus Measurement traffic seen on ${key} but not decoded; set cbus_measurement_app_id `
            + `(typically 228) to publish these readings as sensors.`
        );
    }
}

module.exports = MeasurementEventHandler;
