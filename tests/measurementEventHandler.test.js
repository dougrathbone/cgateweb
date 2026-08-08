const MeasurementEventHandler = require('../src/measurementEventHandler');

// Ground-truth fixture captured live from a real C-Gate instance (project
// HOME) during end-to-end testing: a solar-inverter power reading of
// 123.4 W (device 0/channel 0, units 38 = Watts), confirmed against a
// physical DLT input unit. Real trailing metadata included.
const MEASUREMENT_LINE = 'measurement data //HOME/254/228/0/0 1234 -1 38 #sourceunit=0 OID= sessionId=cmd54 commandId={none}';

function makeDeps(overrides = {}) {
    return {
        eventPublisher: { publishReading: jest.fn() },
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), isLevelEnabled: jest.fn().mockReturnValue(false) },
        settings: { cbus_measurement_app_id: '228' },
        getHaDiscovery: () => null,
        ...overrides,
    };
}

describe('MeasurementEventHandler', () => {
    it('decodes a measurement reading and publishes it under device/channel', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        const consumed = handler.handleLine(MEASUREMENT_LINE);
        expect(consumed).toBe(true);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '228', '0/0', expect.objectContaining({ kind: 'measurement', value: 123.4, unit: 'W' })
        );
    });

    it('consults getHaDiscovery and announces the sensor when discovery is available', () => {
        const ensureMeasurementDiscovery = jest.fn();
        const getHaDiscovery = jest.fn(() => ({ ensureMeasurementDiscovery }));
        const deps = makeDeps({ getHaDiscovery });
        const handler = new MeasurementEventHandler(deps);
        handler.handleLine(MEASUREMENT_LINE);
        expect(getHaDiscovery).toHaveBeenCalled();
        expect(ensureMeasurementDiscovery).toHaveBeenCalledWith(
            '254', '228', '0', '0', expect.objectContaining({ kind: 'measurement' })
        );
    });

    it('does nothing when getHaDiscovery returns null', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        expect(() => handler.handleLine(MEASUREMENT_LINE)).not.toThrow();
    });

    it('returns false and does not publish when the feature is disabled', () => {
        const deps = makeDeps({ settings: { cbus_measurement_app_id: null } });
        const handler = new MeasurementEventHandler(deps);
        const consumed = handler.handleLine(MEASUREMENT_LINE);
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('ignores a non-measurement line without throwing and returns false', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        let consumed;
        expect(() => { consumed = handler.handleLine('lighting on 254/56/4'); }).not.toThrow();
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('returns "unparsed" for a measurement line that fails to decode (malformed args)', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        const consumed = handler.handleLine('measurement data //HOME/254/228/0/0 5042');
        expect(consumed).toBe('unparsed');
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('returns "unparsed" for a measurement line whose application does not match the configured app', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        const consumed = handler.handleLine('measurement data //HOME/254/999/0/0 5042 0 38');
        expect(consumed).toBe('unparsed');
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('returns "unparsed" for an unknown units code', () => {
        const deps = makeDeps();
        const handler = new MeasurementEventHandler(deps);
        const consumed = handler.handleLine('measurement data //HOME/254/228/0/0 5042 0 100');
        expect(consumed).toBe('unparsed');
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });
});
