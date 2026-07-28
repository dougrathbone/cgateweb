const SecurityEventHandler = require('../src/securityEventHandler');

// Verbatim live captures from GitHub issue #42 (64-zone Cytech panel).
const ZONE_UNSEALED_LINE = '# security zone_unsealed //MIDSTRM/254/208/58  #sourceunit=18 OID=';
const ZONE_SEALED_LINE = '# security zone_sealed //MIDSTRM/254/208/58  #sourceunit=18 OID=';
const STATUS_REPORT_1_LINE = '# security status_report_1 //MIDSTRM/254/208 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 0 0 0 0 #sourceunit=18 OID=';
const STATUS_REPORT_2_LINE = '# security status_report_2 //MIDSTRM/254/208  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 #sourceunit=18 OID=';
const SYSTEM_ARM_LINE = '# security system_arm //MIDSTRM/254/208 3 #sourceunit=18 OID=';

function makeDeps(overrides = {}) {
    return {
        eventPublisher: { publishReading: jest.fn() },
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), isLevelEnabled: jest.fn().mockReturnValue(false) },
        settings: { cbus_security_app_id: '208' },
        getHaDiscovery: () => null,
        ...overrides,
    };
}

describe('SecurityEventHandler', () => {
    it('publishes a zone reading for a zone_unsealed line', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine(ZONE_UNSEALED_LINE);
        expect(consumed).toBe(true);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '58', { kind: 'security_zone', zoneState: 'unsealed' }
        );
    });

    it('publishes a sealed zone reading for a zone_sealed line', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        handler.handleLine(ZONE_SEALED_LINE);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '58', { kind: 'security_zone', zoneState: 'sealed' }
        );
    });

    it('triggers event-driven discovery for zones seen', () => {
        const ensureSecurityZoneDiscovery = jest.fn();
        const deps = makeDeps({ getHaDiscovery: () => ({ ensureSecurityZoneDiscovery }) });
        const handler = new SecurityEventHandler(deps);
        handler.handleLine(ZONE_UNSEALED_LINE);
        expect(ensureSecurityZoneDiscovery).toHaveBeenCalledWith('254', '208', '58');
    });

    it('publishes every zone 1-32 from a status_report_1', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine(STATUS_REPORT_1_LINE);
        expect(consumed).toBe(true);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledTimes(32);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '1', { kind: 'security_zone', zoneState: 'sealed' }
        );
        // Positions 30/31 of the capture: zones 27 and 28 are unsealed.
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '27', { kind: 'security_zone', zoneState: 'unsealed' }
        );
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '28', { kind: 'security_zone', zoneState: 'unsealed' }
        );
    });

    it('publishes every zone 33-80 from a status_report_2', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        handler.handleLine(STATUS_REPORT_2_LINE);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledTimes(48);
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '33', { kind: 'security_zone', zoneState: 'sealed' }
        );
        expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
            '254', '208', '80', { kind: 'security_zone', zoneState: 'sealed' }
        );
    });

    it('consumes system-state verbs without publishing MQTT state', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        for (const line of [
            SYSTEM_ARM_LINE,
            '# security arm_ready //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=',
            '# security exit_delay_started //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security arm_failed //MIDSTRM/254/208 arm_failed_raised #sourceunit=18 OID=',
            '# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security zone_isolated //MIDSTRM/254/208/44  #sourceunit=18 OID=',
            '# security fire_alarm //MIDSTRM/254/208 fire_alarm_raised #sourceunit=18 OID='
        ]) {
            expect(handler.handleLine(line)).toBe(true);
        }
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        expect(deps.logger.warn).not.toHaveBeenCalled();
    });

    it('returns false and does not publish when the feature is disabled', () => {
        for (const settings of [{ cbus_security_app_id: null }, { cbus_security_app_id: '' }, { cbus_security_app_id: '0' }]) {
            const deps = makeDeps({ settings });
            const handler = new SecurityEventHandler(deps);
            expect(handler.handleLine(ZONE_UNSEALED_LINE)).toBe(false);
            expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        }
    });

    it('ignores a non-security line without throwing and returns false', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        let consumed;
        expect(() => { consumed = handler.handleLine('garbage'); }).not.toThrow();
        expect(consumed).toBe(false);
    });

    it('returns false for a security line that fails to decode so it falls through', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('security some_unknown_verb //MIDSTRM/254/208 1');
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('returns false for a security line whose application does not match the configured app', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('# security zone_unsealed //MIDSTRM/254/207/58');
        expect(consumed).toBe(false);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    describe('initial status sync on first traffic', () => {
        it('sends status_request 1 and 2 once per network', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            handler.handleLine(ZONE_SEALED_LINE); // same network again
            expect(deps.sendCommand).toHaveBeenCalledTimes(2);
            expect(deps.sendCommand).toHaveBeenNthCalledWith(1, 'security status_request //MIDSTRM/254/208 1\n');
            expect(deps.sendCommand).toHaveBeenNthCalledWith(2, 'security status_request //MIDSTRM/254/208 2\n');
        });

        it('syncs each newly seen network independently', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE); // network 254
            handler.handleLine('# security zone_unsealed //MIDSTRM/255/208/3'); // network 255
            expect(deps.sendCommand).toHaveBeenCalledTimes(4);
            expect(deps.sendCommand).toHaveBeenLastCalledWith('security status_request //MIDSTRM/255/208 2\n');
        });

        it('does nothing without a command sink or project name', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            expect(() => handler.handleLine(ZONE_UNSEALED_LINE)).not.toThrow();
        });
    });

    describe('isSecurityLine', () => {
        const handler = new SecurityEventHandler(makeDeps());

        it('recognises security traffic, with or without a # comment prefix', () => {
            expect(handler.isSecurityLine('security zone_unsealed //MIDSTRM/254/208/58')).toBe(true);
            expect(handler.isSecurityLine('# security zone_unsealed //MIDSTRM/254/208/58')).toBe(true);
            expect(handler.isSecurityLine('  security foo')).toBe(true);
        });

        it('returns false for non-security lines and other comments', () => {
            expect(handler.isSecurityLine('lighting on //MIDSTRM/254/56/4')).toBe(false);
            expect(handler.isSecurityLine('# some other comment')).toBe(false);
            expect(handler.isSecurityLine('aircon zone_temperature //MIDSTRM/254/172 1 0 4431')).toBe(false);
        });

        it('is independent of whether the feature is enabled', () => {
            const disabled = new SecurityEventHandler(makeDeps({ settings: { cbus_security_app_id: '0' } }));
            expect(disabled.isSecurityLine('security zone_unsealed //MIDSTRM/254/208/58')).toBe(true);
        });
    });
});
