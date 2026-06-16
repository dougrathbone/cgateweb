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
});
