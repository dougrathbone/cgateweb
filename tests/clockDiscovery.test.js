const HaDiscovery = require('../src/haDiscovery');
const { findDiscoveryPayload } = require('./helpers/discovery');

const DATE_TOPIC = 'homeassistant/sensor/cgateweb_254_223_clock_date/config';
const TIME_TOPIC = 'homeassistant/sensor/cgateweb_254_223_clock_time/config';

describe('HaDiscovery — app 223 network clock sensors', () => {
    let publishFn;
    let d;

    const payloadAt = (topic) => {
        const payload = findDiscoveryPayload(publishFn, topic);
        expect(payload).toBeDefined();
        return payload;
    };

    beforeEach(() => {
        publishFn = jest.fn();
        d = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn()
        );
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('publishes a date and a time sensor pointing at the clock topics', () => {
        expect(d.ensureClockDiscovery('254', '223')).toBe(true);

        const date = payloadAt(DATE_TOPIC);
        expect(date.state_topic).toBe('cbus/read/254/223/clock/date');
        expect(date.unique_id).toBe('cgateweb_254_223_clock_date');
        expect(date.name).toBe('Clock Date');

        const time = payloadAt(TIME_TOPIC);
        expect(time.state_topic).toBe('cbus/read/254/223/clock/time');
        expect(time.unique_id).toBe('cgateweb_254_223_clock_time');
        expect(time.name).toBe('Clock Time');
    });

    it('marks both sensors as diagnostic', () => {
        d.ensureClockDiscovery('254', '223');
        expect(payloadAt(DATE_TOPIC).entity_category).toBe('diagnostic');
        expect(payloadAt(TIME_TOPIC).entity_category).toBe('diagnostic');
    });

    // The deliberate omission. HA's timestamp device_class demands an ISO 8601
    // datetime WITH a UTC offset; app 223 broadcasts date and time separately
    // and neither carries a timezone. Claiming timestamp would mean inventing
    // one, and would render a drifted clock as a plausible relative time —
    // hiding the exact fault the sensor exists to reveal.
    it('claims no device_class or unit, because neither would be honest', () => {
        d.ensureClockDiscovery('254', '223');
        for (const topic of [DATE_TOPIC, TIME_TOPIC]) {
            const payload = payloadAt(topic);
            expect(payload.device_class).toBeUndefined();
            expect(payload.unit_of_measurement).toBeUndefined();
            expect(payload.state_class).toBeUndefined();
        }
    });

    it('puts both sensors on the shared C-Bus Network device', () => {
        d.ensureClockDiscovery('254', '223');
        for (const topic of [DATE_TOPIC, TIME_TOPIC]) {
            const device = payloadAt(topic).device;
            expect(device.identifiers).toEqual(['cgateweb_network_254']);
            expect(device.name).toBe('C-Bus Network 254');
        }
    });

    it('accepts numeric network and app ids', () => {
        expect(d.ensureClockDiscovery(254, 223)).toBe(true);
        expect(payloadAt(DATE_TOPIC).state_topic).toBe('cbus/read/254/223/clock/date');
    });

    it('is idempotent per network, and independent across networks', () => {
        expect(d.ensureClockDiscovery('254', '223')).toBe(true);
        expect(d.ensureClockDiscovery('254', '223')).toBe(false);
        expect(publishFn.mock.calls.filter(c => c[0] === DATE_TOPIC)).toHaveLength(1);

        expect(d.ensureClockDiscovery('1', '223')).toBe(true);
        expect(publishFn.mock.calls
            .filter(c => c[0] === 'homeassistant/sensor/cgateweb_1_223_clock_date/config')).toHaveLength(1);
    });

    it('does nothing when discovery is disabled', () => {
        const off = new HaDiscovery(
            { ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn()
        );
        expect(off.ensureClockDiscovery('254', '223')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('ignores a null or undefined network or app id', () => {
        expect(d.ensureClockDiscovery(null, '223')).toBe(false);
        expect(d.ensureClockDiscovery('254', undefined)).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('clears previously published sensors when the clock is excluded', () => {
        const excluded = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn(),
            { exclude: new Set(['254/223/clock']) }
        );
        expect(excluded.ensureClockDiscovery('254', '223')).toBe(false);

        for (const topic of [DATE_TOPIC, TIME_TOPIC]) {
            const call = publishFn.mock.calls.find(c => c[0] === topic);
            expect(call).toBeDefined();
            expect(call[1]).toBe(''); // empty retained payload removes the entity
        }

        // …and it stays quiet on subsequent events
        expect(excluded.ensureClockDiscovery('254', '223')).toBe(false);
        expect(publishFn.mock.calls.filter(c => c[0] === DATE_TOPIC)).toHaveLength(1);
    });
});
