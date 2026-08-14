const MeasurementEventHandler = require('../src/measurementEventHandler');
const CBusEvent = require('../src/cbusEvent');
const { LINE_UNPARSED } = require('../src/applicationDecoders/appEventLine');

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

    // Reported on #60 by a user with a real temperature sensor: with the
    // feature off, "measurement data //MIDSTRM/254/228/23/1 2206 -2 0" was
    // reaching CBusEvent, which read the 4-segment address as 254/228/23 and
    // the raw 2206 as a lighting level - publishing his 22.06 degree sensor as
    // ON at 865%. Measurement lines carry no '#' prefix, so unlike aircon and
    // security traffic they do not land on the comment-dropping branch.
    describe('when the feature is disabled', () => {
        const DISABLED = { settings: { cbus_measurement_app_id: null } };

        it('still claims the line so it never reaches the standard parser', () => {
            const deps = makeDeps(DISABLED);
            const handler = new MeasurementEventHandler(deps);
            expect(handler.handleLine(MEASUREMENT_LINE)).toBe(LINE_UNPARSED);
            expect(handler.handleLine(MEASUREMENT_LINE)).not.toBe(false);
        });

        it('publishes nothing', () => {
            const deps = makeDeps(DISABLED);
            new MeasurementEventHandler(deps).handleLine(MEASUREMENT_LINE);
            expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        });

        it('points at the setting once per network/application, not once per line', () => {
            // These broadcast continuously, so the hint has to be capped or it
            // becomes the log.
            const deps = makeDeps(DISABLED);
            const handler = new MeasurementEventHandler(deps);
            for (let i = 0; i < 5; i += 1) handler.handleLine(MEASUREMENT_LINE);
            handler.handleLine('measurement data //HOME/253/228/0/0 1234 -1 38');

            const hints = deps.logger.info.mock.calls.map(c => c[0])
                .filter(m => m.includes('cbus_measurement_app_id'));
            expect(hints).toHaveLength(2);
            expect(hints[0]).toContain('254/228');
            expect(hints[1]).toContain('253/228');
        });
    });

    // The address shape that actually misparsed in #60, end to end.
    it('keeps a 4-segment address out of the standard event parser', () => {
        const line = 'measurement data //MIDSTRM/254/228/23/1 2206 -2 0 #sourceunit=22 OID=';
        // CBusEvent accepts it and gets it wrong - which is why the handler
        // must claim it first.
        const misparsed = new CBusEvent(line);
        expect(misparsed.isValid()).toBe(true);
        expect(misparsed.getLevel()).toBe(2206);

        expect(new MeasurementEventHandler(makeDeps({ settings: { cbus_measurement_app_id: null } }))
            .handleLine(line)).toBe(LINE_UNPARSED);

        const deps = makeDeps();
        expect(new MeasurementEventHandler(deps).handleLine(line)).toBe(true);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '228', '23/1',
            expect.objectContaining({ value: 22.06, unit: '\u00b0C', deviceClass: 'temperature' })
        );
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
