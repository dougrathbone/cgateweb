const AirconEventHandler = require('../src/airconEventHandler');

// A real mode line exercised by tests/cgateWebBridge.test.js. Decodes to a
// 'mode' reading (application 172), which records into the registry and publishes.
const AIRCON_MODE_LINE = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=250 OID=x';

function makeDeps(overrides = {}) {
    return {
        registry: { recordModeReading: jest.fn() },
        eventPublisher: { publishReading: jest.fn() },
        logger: { debug: jest.fn(), warn: jest.fn(), isLevelEnabled: jest.fn().mockReturnValue(false) },
        settings: { cbus_aircon_app_id: '172' },
        getHaDiscovery: () => null,
        ...overrides,
    };
}

describe('AirconEventHandler', () => {
    it('records a decoded mode reading in the registry and publishes it', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        const consumed = handler.handleLine(AIRCON_MODE_LINE);
        expect(consumed).toBe(true);
        expect(deps.registry.recordModeReading).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'mode', application: '172' })
        );
        // publishReading(network, application, group, reading) — application is
        // guaranteed '172' by the feature gate; pin it plus the reading payload.
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            expect.anything(), '172', expect.anything(), expect.objectContaining({ kind: 'mode' })
        );
    });

    it('consults getHaDiscovery and announces the thermostat when discovery is available', () => {
        const ensureNativeAirconDiscovery = jest.fn();
        const getHaDiscovery = jest.fn(() => ({ ensureNativeAirconDiscovery }));
        const deps = makeDeps({ getHaDiscovery });
        const handler = new AirconEventHandler(deps);
        handler.handleLine(AIRCON_MODE_LINE);
        expect(getHaDiscovery).toHaveBeenCalled();
        expect(ensureNativeAirconDiscovery).toHaveBeenCalled();
    });

    it('warns once on an unmapped HVAC mode code', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        // mode code 9 is not in the HVAC map, so reading.mode resolves to null.
        handler.handleLine('aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 9 0 0 0 1 255 0 0 #sourceunit=250 OID=x');
        expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unmapped C-Bus HVAC mode code'));
    });

    it('returns false and does not record when the feature is disabled', () => {
        const deps = makeDeps({ settings: { cbus_aircon_app_id: null } });
        const handler = new AirconEventHandler(deps);
        const consumed = handler.handleLine(AIRCON_MODE_LINE);
        expect(consumed).toBe(false);
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });

    it('ignores a non-aircon line without throwing and returns false', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        let consumed;
        expect(() => { consumed = handler.handleLine('garbage'); }).not.toThrow();
        expect(consumed).toBe(false);
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });

    it('returns false for an aircon line that fails to decode so it falls through', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        // Unsupported verb → decoder returns null; nothing published/recorded.
        const consumed = handler.handleLine('aircon some_unknown_verb //THEGAFF/254/172 1 0');
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });

    it('returns false for an aircon line whose application does not match the configured app', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        // Decodes cleanly but app 999 != configured 172 → should fall through.
        const consumed = handler.handleLine('aircon set_zone_hvac_mode //THEGAFF/254/999 1 0,1,2,3,4 1 0 0 0 1 3 5632 0 #sourceunit=202 OID=x');
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });

    describe('plant error warnings (edge-triggered)', () => {
        // Spec-derived: bitmask 78 = 64(error)+8+4+2, error code 4 = temperature sensor failure
        const ERROR_LINE = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 78 4 #sourceunit=201 OID=x';
        const CLEAR_LINE = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 14 0 #sourceunit=201 OID=x';

        it('warns on a non-zero HVAC error code, once per code per unit', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(ERROR_LINE);
            handler.handleLine(ERROR_LINE); // same code again → no repeat warn
            expect(deps.logger.warn).toHaveBeenCalledTimes(1);
            expect(deps.logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Temperature sensor failure')
            );
        });

        it('re-warns after the error clears and recurs, and warns again on a different code', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(ERROR_LINE);
            handler.handleLine(CLEAR_LINE);  // code 0 → rearm
            handler.handleLine(ERROR_LINE);
            expect(deps.logger.warn).toHaveBeenCalledTimes(2);
            // A different non-zero code (2 = cooler total failure) warns again
            handler.handleLine('# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 66 2 #sourceunit=201 OID=x');
            expect(deps.logger.warn).toHaveBeenCalledTimes(3);
        });

        it('does not warn for error code 0', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(CLEAR_LINE);
            expect(deps.logger.warn).not.toHaveBeenCalled();
        });

        it('tracks error state independently per unit', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(ERROR_LINE); // unit 201
            handler.handleLine('# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 66 4 #sourceunit=202 OID=x'); // unit 202, same code
            expect(deps.logger.warn).toHaveBeenCalledTimes(2);
        });
    });

    describe('temperature sensor fault warnings (edge-triggered)', () => {
        // Spec §25.6.12: 0 ok, 1 relaxed accuracy, 2 out of calibration, 3 total failure
        const OK_LINE = '# aircon zone_temperature //THEGAFF/254/172 1 0 4431 0 #sourceunit=201 OID=x';
        const CAL_LINE = '# aircon zone_temperature //THEGAFF/254/172 1 0 4431 2 #sourceunit=201 OID=x';
        const FAIL_LINE = '# aircon zone_temperature //THEGAFF/254/172 1 0 4431 3 #sourceunit=201 OID=x';

        it('warns once per status on out-of-calibration and total failure', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(CAL_LINE);
            handler.handleLine(CAL_LINE); // same status again → no repeat warn
            handler.handleLine(FAIL_LINE); // escalates → warns again
            expect(deps.logger.warn).toHaveBeenCalledTimes(2);
            expect(deps.logger.warn).toHaveBeenNthCalledWith(1, expect.stringContaining('out of calibration'));
            expect(deps.logger.warn).toHaveBeenNthCalledWith(2, expect.stringContaining('total failure'));
        });

        it('rearms once the sensor reports a healthy status again', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(FAIL_LINE);
            handler.handleLine(OK_LINE);  // healthy → rearm
            handler.handleLine(FAIL_LINE);
            expect(deps.logger.warn).toHaveBeenCalledTimes(2);
        });

        it('does not warn for status 0 or 1', () => {
            const deps = makeDeps();
            const handler = new AirconEventHandler(deps);
            handler.handleLine(OK_LINE);
            handler.handleLine('# aircon zone_temperature //THEGAFF/254/172 1 0 4431 1 #sourceunit=201 OID=x');
            expect(deps.logger.warn).not.toHaveBeenCalled();
        });
    });

    describe('isAirconLine', () => {
        const handler = new AirconEventHandler(makeDeps());

        it('recognises aircon traffic, with or without a # comment prefix', () => {
            expect(handler.isAirconLine('aircon set_zone_hvac_mode //THEGAFF/254/172 1 0')).toBe(true);
            expect(handler.isAirconLine('# aircon set_zone_hvac_mode //THEGAFF/254/172 1 0')).toBe(true);
            expect(handler.isAirconLine('  aircon foo')).toBe(true);
        });

        it('returns false for non-aircon lines and other comments', () => {
            expect(handler.isAirconLine('lighting on //THEGAFF/254/56/4')).toBe(false);
            expect(handler.isAirconLine('# some other comment')).toBe(false);
            expect(handler.isAirconLine('clock date 2026-06-16')).toBe(false);
        });

        it('is independent of whether the feature is enabled', () => {
            const disabled = new AirconEventHandler(makeDeps({ settings: { cbus_aircon_app_id: null } }));
            expect(disabled.isAirconLine('aircon set_zone_hvac_mode //THEGAFF/254/172 1 0')).toBe(true);
        });
    });
});
