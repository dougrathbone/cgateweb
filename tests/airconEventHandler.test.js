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
        expect(deps.registry.recordModeReading).toHaveBeenCalled();
        expect(deps.eventPublisher.publishReading).toHaveBeenCalled();
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
        expect(() => handler.handleLine('garbage')).not.toThrow();
        let consumed;
        expect(() => { consumed = handler.handleLine('garbage'); }).not.toThrow();
        expect(consumed).toBe(false);
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });
});
