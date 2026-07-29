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

    it('logs a discrete zone event at DEBUG (routine traffic — INFO is reserved for system verbs)', () => {
        const deps = makeDeps({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), isLevelEnabled: jest.fn().mockReturnValue(true) } });
        const handler = new SecurityEventHandler(deps);
        handler.handleLine(ZONE_UNSEALED_LINE);
        expect(deps.logger.debug).toHaveBeenCalledWith('Security zone 254/208/58: unsealed');
        expect(deps.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Security zone'));
    });

    it('logs a one-line DEBUG summary for status reports (counts per state, not per zone)', () => {
        const deps = makeDeps({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), isLevelEnabled: jest.fn().mockReturnValue(true) } });
        const handler = new SecurityEventHandler(deps);
        handler.handleLine(STATUS_REPORT_1_LINE);
        const summary = deps.logger.debug.mock.calls.map(c => c[0]).find(m => typeof m === 'string' && m.includes('status_report_1'));
        expect(summary).toBeDefined();
        expect(summary).toContain('32 zones (30 sealed, 2 unsealed)');
        expect(summary).toContain('arm=disarmed');
        expect(summary).toContain('tamper=ok');
        // No per-zone INFO lines for report-published zones
        expect(deps.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Security zone'));
    });

    it('consumes our own status_request echoes quietly (no publish, no INFO, no re-sync)', () => {
        const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('security status_request //MIDSTRM/254/208 1 #sourceunit=0 OID= sessionId=cmd6 commandId={none}');
        expect(consumed).toBe(true);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        expect(deps.logger.info).not.toHaveBeenCalled();
        expect(deps.logger.warn).not.toHaveBeenCalled();
        // An echo must not count as "first traffic" and trigger a sync request
        expect(deps.sendCommand).not.toHaveBeenCalled();
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

    describe('humanized INFO logs for system verbs', () => {
        const cases = [
            ['# security system_arm //MIDSTRM/254/208 3 #sourceunit=18 OID=', 'C-Bus Security: System armed (Day mode) (254/208)'],
            ['# security system_arm //MIDSTRM/254/208 1 #sourceunit=18 OID=', 'C-Bus Security: System armed (Away mode) (254/208)'],
            ['# security system_arm //MIDSTRM/254/208 0 #sourceunit=18 OID=', 'C-Bus Security: System disarmed (254/208)'],
            ['# security arm_ready //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Ready to arm (254/208)'],
            ['# security exit_delay_started //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Exit delay started (254/208)'],
            ['# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=', 'C-Bus Security: Zone 44 open — not ready to arm (254/208)'],
            ['# security zone_isolated //MIDSTRM/254/208/44  #sourceunit=18 OID=', 'C-Bus Security: Zone 44 bypassed (254/208)'],
            ['# security arm_failed //MIDSTRM/254/208 arm_failed_raised #sourceunit=18 OID=', 'C-Bus Security: Arm failed (arm_failed_raised) (254/208)'],
            ['# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Alarm on (254/208)'],
            ['# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Alarm off (254/208)'],
            ['# security fire_alarm //MIDSTRM/254/208 fire_alarm_raised #sourceunit=18 OID=', 'C-Bus Security: Fire alarm (fire_alarm_raised) (254/208)']
        ];

        it.each(cases)('logs %s', (line, expected) => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(line);
            expect(deps.logger.info).toHaveBeenCalledWith(expected);
        });
    });

    describe('Live Events (SSE) feed', () => {
        it('emits an on/off event-log entry for discrete zone events', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            handler.handleLine(ZONE_SEALED_LINE);
            expect(onEventLog).toHaveBeenCalledTimes(2);
            expect(onEventLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
                network: '254', app: '208', group: '58', level: 255, type: 'on'
            }));
            expect(onEventLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
                network: '254', app: '208', group: '58', level: 0, type: 'off'
            }));
        });

        it('emits event-log entries for system events (zone-bearing verbs use the zone)', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(SYSTEM_ARM_LINE); // mode 3 = armed
            handler.handleLine('# security system_arm //MIDSTRM/254/208 0 #sourceunit=18 OID=');
            handler.handleLine('# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=');
            expect(onEventLog).toHaveBeenNthCalledWith(1, expect.objectContaining({ group: '0', level: 255, type: 'on' }));
            expect(onEventLog).toHaveBeenNthCalledWith(2, expect.objectContaining({ group: '0', level: 0, type: 'off' }));
            expect(onEventLog).toHaveBeenNthCalledWith(3, expect.objectContaining({ group: '44', level: 0, type: 'update' }));
        });

        it('does not flood the stream for status reports or echoes', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(STATUS_REPORT_1_LINE);
            handler.handleLine(STATUS_REPORT_2_LINE);
            handler.handleLine('security status_request //MIDSTRM/254/208 1 #sourceunit=0 OID= sessionId=cmd6 commandId={none}');
            expect(onEventLog).not.toHaveBeenCalled();
        });

        it('includes the application-1 zone label in zone entries when known', () => {
            const onEventLog = jest.fn();
            const getHaDiscovery = () => ({
                ensureSecurityZoneDiscovery: jest.fn(),
                labelMap: new Map([['254/1/58', 'Front Door']])
            });
            const deps = makeDeps({ onEventLog, getHaDiscovery });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            expect(onEventLog).toHaveBeenCalledWith(expect.objectContaining({
                network: '254', app: '208', group: '58', label: 'Front Door'
            }));
        });

        it('labels zone-bearing system events (arm_not_ready) the same way', () => {
            const onEventLog = jest.fn();
            const getHaDiscovery = () => ({
                ensureSecurityZoneDiscovery: jest.fn(),
                labelMap: new Map([['254/1/44', 'Kitchen Window']])
            });
            const deps = makeDeps({ onEventLog, getHaDiscovery });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=');
            expect(onEventLog).toHaveBeenCalledWith(expect.objectContaining({
                group: '44', label: 'Kitchen Window'
            }));
        });

        it('omits the label field when the zone has no label (address semantics unchanged)', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog, getHaDiscovery: () => ({ ensureSecurityZoneDiscovery: jest.fn() }) });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            const entry = onEventLog.mock.calls[0][0];
            expect('label' in entry).toBe(false);
            expect(entry).toMatchObject({ network: '254', app: '208', group: '58' });
        });
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

    describe('status_request sync dedupe (requestStatusSync)', () => {
        it('sends status_request 1 and 2 once per network on first traffic', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            handler.handleLine(ZONE_SEALED_LINE); // same network again
            expect(deps.sendCommand).toHaveBeenCalledTimes(2);
            expect(deps.sendCommand).toHaveBeenNthCalledWith(1, 'security status_request //MIDSTRM/254/208 1\n');
            expect(deps.sendCommand).toHaveBeenNthCalledWith(2, 'security status_request //MIDSTRM/254/208 2\n');
        });

        it('sends at most one "early" pair across the connect and traffic triggers', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            expect(handler.requestStatusSync('254', 'connect')).toBe(true);
            expect(handler.requestStatusSync('254', 'connect')).toBe(false); // duplicate
            handler.handleLine(ZONE_UNSEALED_LINE); // traffic — early slot already used
            expect(deps.sendCommand).toHaveBeenCalledTimes(2);
        });

        it('allows one post-762 pair in addition to the early pair', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.requestStatusSync('254', 'connect');
            expect(handler.requestStatusSync('254', 'sync')).toBe(true);  // 762 → second pair
            expect(handler.requestStatusSync('254', 'sync')).toBe(false); // deduped
            handler.handleLine(ZONE_UNSEALED_LINE);                        // still deduped
            expect(deps.sendCommand).toHaveBeenCalledTimes(4);
        });

        it('fires the early pair on first traffic when connect never happened (no-762 sessions)', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            expect(handler.requestStatusSync('254', 'connect')).toBe(false); // too late, traffic won
            expect(deps.sendCommand).toHaveBeenCalledTimes(2);
        });

        it('logs when a request is sent, and does not log when skipped as duplicate', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.requestStatusSync('254', 'connect');
            handler.requestStatusSync('254', 'connect');
            handler.requestStatusSync('254', 'sync');
            handler.requestStatusSync('254', 'sync');
            const syncLogs = deps.logger.info.mock.calls
                .map(c => c[0])
                .filter(m => typeof m === 'string' && m.includes('Requested security zone status sync'));
            expect(syncLogs).toHaveLength(2);
            expect(syncLogs[0]).toContain('trigger: connect');
            expect(syncLogs[1]).toContain('trigger: sync');
        });

        it('syncs each newly seen network independently', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE); // network 254
            handler.handleLine('# security zone_unsealed //MIDSTRM/255/208/3'); // network 255
            expect(deps.sendCommand).toHaveBeenCalledTimes(4);
            expect(deps.sendCommand).toHaveBeenLastCalledWith('security status_request //MIDSTRM/255/208 2\n');
        });

        it('does nothing without a command sink, project name, or when disabled', () => {
            const noSink = new SecurityEventHandler(makeDeps());
            expect(noSink.requestStatusSync('254', 'connect')).toBe(false);
            const disabled = new SecurityEventHandler(makeDeps({
                settings: { cbus_security_app_id: '0' },
                cbusname: 'MIDSTRM',
                sendCommand: jest.fn()
            }));
            expect(disabled.requestStatusSync('254', 'connect')).toBe(false);
            expect(() => noSink.handleLine(ZONE_UNSEALED_LINE)).not.toThrow();
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
