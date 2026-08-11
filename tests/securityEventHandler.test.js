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
        const zoneReadings = deps.eventPublisher.publishReading.mock.calls
            .filter(c => c[3] && c[3].kind === 'security_zone');
        expect(zoneReadings).toHaveLength(32);
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

    // Same treatment for `security arm` echoes. Reported in #42 as
    // "Security line not decoded (verb pending support)" noise. Crucially the
    // echo must not move the alarm state: the panel's exit_delay_started and
    // system_arm events that follow are the authority.
    it('consumes our own arm echoes quietly and does not publish alarm state', () => {
        const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('security arm //MIDSTRM/254/208 day #sourceunit=0 OID= sessionId=cmd11 commandId={none}');
        expect(consumed).toBe(true);
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        expect(deps.logger.info).not.toHaveBeenCalled();
        expect(deps.logger.warn).not.toHaveBeenCalled();
        expect(deps.sendCommand).not.toHaveBeenCalled();
    });

    // arm_failed and fire_alarm are deliberately absent: they are panel trouble
    // conditions now and do publish state (see 'panel trouble conditions'). The
    // arm/alarm verbs here drive the alarm_control_panel state — but no zone state.
    it('consumes arm-progress and alarm verbs without publishing zone state', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        for (const line of [
            SYSTEM_ARM_LINE,
            '# security arm_ready //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=',
            '# security exit_delay_started //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID=',
            '# security zone_isolated //MIDSTRM/254/208/44  #sourceunit=18 OID='
        ]) {
            expect(handler.handleLine(line)).toBe(true);
        }
        const zoneReadings = deps.eventPublisher.publishReading.mock.calls
            .filter(c => c[3] && c[3].kind === 'security_zone');
        expect(zoneReadings).toHaveLength(0);
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
            ['# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Alarm on (254/208)'],
            ['# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Alarm off (254/208)'],
            // Panel trouble conditions. The raw _raised/_cleared argument is
            // dropped from the log line: the sense is already in the wording.
            ['# security arm_failed //MIDSTRM/254/208 arm_failed_raised #sourceunit=18 OID=', 'C-Bus Security: Arm failed (254/208)'],
            ['# security arm_failed //MIDSTRM/254/208 arm_failed_cleared #sourceunit=18 OID=', 'C-Bus Security: Arm failure cleared (254/208)'],
            ['# security fire_alarm //MIDSTRM/254/208 fire_alarm_raised #sourceunit=18 OID=', 'C-Bus Security: Fire alarm (254/208)'],
            ['# security fire_alarm //MIDSTRM/254/208 fire_alarm_cleared #sourceunit=18 OID=', 'C-Bus Security: Fire alarm cleared (254/208)'],
            ['# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Mains power failure (254/208)'],
            ['# security mains_restored //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Mains power restored (254/208)'],
            ['# security low_battery //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Battery low (254/208)'],
            ['# security low_battery_corrected //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Battery restored (254/208)'],
            ['# security tamper_on //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Tamper detected (254/208)'],
            ['# security tamper_off //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Tamper cleared (254/208)'],
            ['# security panic_activated //MIDSTRM/254/208  #sourceunit=18 OID=', 'C-Bus Security: Panic activated (254/208)'],
            ['# security line_cut_alarm //MIDSTRM/254/208 line_cut_alarm_raised #sourceunit=18 OID=', 'C-Bus Security: Phone line cut (254/208)'],
            ['# security line_cut_alarm //MIDSTRM/254/208 line_cut_alarm_cleared #sourceunit=18 OID=', 'C-Bus Security: Phone line restored (254/208)']
        ];

        it.each(cases)('logs %s', (line, expected) => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(line);
            expect(deps.logger.info).toHaveBeenCalledWith(expected);
        });
    });

    describe('panel trouble conditions', () => {
        it('publishes ON for a mains failure and OFF when restored', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=');
            expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
                '254', '208', 'panel/mains', { kind: 'security_panel', active: true }
            );
            handler.handleLine('# security mains_restored //MIDSTRM/254/208  #sourceunit=18 OID=');
            expect(deps.eventPublisher.publishReading).toHaveBeenLastCalledWith(
                '254', '208', 'panel/mains', { kind: 'security_panel', active: false }
            );
        });

        it('does not republish a repeated raise', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=');
            deps.eventPublisher.publishReading.mockClear();
            handler.handleLine('# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=');
            expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
        });

        it('clears panic on disarm even though the panel sends no panic_off', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security panic_activated //MIDSTRM/254/208  #sourceunit=18 OID=');
            handler.handleLine('# security system_arm //MIDSTRM/254/208 0 #sourceunit=18 OID=');
            expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
                '254', '208', 'panel/panic', { kind: 'security_panel', active: false }
            );
        });

        it('triggers panel discovery on the first trouble event', () => {
            const ensureSecurityPanelDiscovery = jest.fn();
            const deps = makeDeps({
                getHaDiscovery: () => ({ ensureSecurityZoneDiscovery: jest.fn(), ensureSecurityPanelDiscovery })
            });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=');
            expect(ensureSecurityPanelDiscovery).toHaveBeenCalledWith('254', '208');
        });

        it('seeds tamper from a status_report_1 so the panel sensor reflects reality', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            // arm state 0, tamper 255 (active), panic 0, then zone values.
            handler.handleLine('# security status_report_1 //MIDSTRM/254/208 0 255 0 0 0 0 #sourceunit=18 OID=');
            expect(deps.eventPublisher.publishReading).toHaveBeenCalledWith(
                '254', '208', 'panel/tamper', { kind: 'security_panel', active: true }
            );
        });

        it('consumes the line and logs at INFO with a Live Events description', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            expect(handler.handleLine('# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=')).toBe(true);
            expect(deps.logger.info).toHaveBeenCalledWith('C-Bus Security: Mains power failure (254/208)');
            expect(onEventLog).toHaveBeenCalledWith(expect.objectContaining({
                group: null, description: 'Mains power failure'
            }));
        });
    });

    describe('alarm panel state publishing', () => {
        function alarmReadings(deps) {
            return deps.eventPublisher.publishReading.mock.calls
                .filter(c => c[3] && c[3].kind === 'security_alarm');
        }

        it('publishes the HA alarm state on system_arm, deduped', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(SYSTEM_ARM_LINE); // mode 3 = day/stay
            handler.handleLine(SYSTEM_ARM_LINE); // repeat — no republish
            const calls = alarmReadings(deps);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual(['254', '208', 'panel',
                { kind: 'security_alarm', alarmState: 'armed_home', blockingZone: null }]);
        });

        it('maps disarm and the arm modes to HA states', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security system_arm //MIDSTRM/254/208 1 #sourceunit=18 OID=');
            handler.handleLine('# security system_arm //MIDSTRM/254/208 0 #sourceunit=18 OID=');
            expect(alarmReadings(deps).map(c => c[3].alarmState)).toEqual(['armed_away', 'disarmed']);
        });

        it('publishes pending with the blocking zone on arm_not_ready', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID=');
            expect(alarmReadings(deps)[0][3]).toEqual(
                { kind: 'security_alarm', alarmState: 'pending', blockingZone: '44' });
        });

        it('walks exit delay to armed, and triggered back to the pre-alarm state', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine('# security exit_delay_started //MIDSTRM/254/208  #sourceunit=18 OID=');
            handler.handleLine(SYSTEM_ARM_LINE);
            handler.handleLine('# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID=');
            handler.handleLine('# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID=');
            expect(alarmReadings(deps).map(c => c[3].alarmState))
                .toEqual(['arming', 'armed_home', 'triggered', 'armed_home']);
        });

        it('seeds the state from a status_report_1 arm-state prefix', () => {
            const deps = makeDeps();
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(STATUS_REPORT_1_LINE); // arm state 0
            const calls = alarmReadings(deps);
            expect(calls).toHaveLength(1);
            expect(calls[0][3].alarmState).toBe('disarmed');
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
            // Panel-wide verbs carry no zone, so group is null and the UI renders
            // the address as net/app rather than a bogus net/app/0.
            expect(onEventLog).toHaveBeenNthCalledWith(1, expect.objectContaining({ group: null, level: 255, type: 'on' }));
            expect(onEventLog).toHaveBeenNthCalledWith(2, expect.objectContaining({ group: null, level: 0, type: 'off' }));
            expect(onEventLog).toHaveBeenNthCalledWith(3, expect.objectContaining({ group: '44', level: 0, type: 'update' }));
        });

        it('describes zone entries so the UI need not render a level percentage', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(ZONE_UNSEALED_LINE);
            handler.handleLine(ZONE_SEALED_LINE);
            expect(onEventLog).toHaveBeenNthCalledWith(1, expect.objectContaining({ description: 'Zone unsealed' }));
            expect(onEventLog).toHaveBeenNthCalledWith(2, expect.objectContaining({ description: 'Zone sealed' }));
        });

        it('describes system entries with the same text used for the INFO log', () => {
            const onEventLog = jest.fn();
            const deps = makeDeps({ onEventLog });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(SYSTEM_ARM_LINE);
            handler.handleLine('# security system_arm //MIDSTRM/254/208 0 #sourceunit=18 OID=');
            handler.handleLine('# security zone_isolated //MIDSTRM/254/208/44  #sourceunit=18 OID=');
            expect(onEventLog).toHaveBeenNthCalledWith(1, expect.objectContaining({ description: 'System armed (Day mode)' }));
            expect(onEventLog).toHaveBeenNthCalledWith(2, expect.objectContaining({ description: 'System disarmed' }));
            expect(onEventLog).toHaveBeenNthCalledWith(3, expect.objectContaining({ description: 'Zone 44 bypassed' }));
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

    it('returns "unparsed" for a security line that fails to decode so the bridge keeps it out of the generic parser', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('security some_unknown_verb //MIDSTRM/254/208 1');
        expect(consumed).toBe('unparsed');
        expect(deps.eventPublisher.publishReading).not.toHaveBeenCalled();
    });

    it('returns "unparsed" for a security line whose application does not match the configured app', () => {
        const deps = makeDeps();
        const handler = new SecurityEventHandler(deps);
        const consumed = handler.handleLine('# security zone_unsealed //MIDSTRM/254/207/58');
        expect(consumed).toBe('unparsed');
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

        // Issue #44: HA can restart any number of times in one bridge session,
        // and every restart genuinely needs the zone state resent. Rate limiting
        // for this trigger is the resync coordinator's debounce, not the dedupe.
        it('exempts the resync trigger from the once-per-session dedupe', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.requestStatusSync('254', 'connect');
            handler.requestStatusSync('254', 'sync');
            expect(handler.requestStatusSync('254', 'resync')).toBe(true);
            expect(handler.requestStatusSync('254', 'resync')).toBe(true);
            expect(deps.sendCommand).toHaveBeenCalledTimes(8); // 4 pairs
        });

        // #51: HA drops entity state when it restarts, the bridge does not, and
        // the alarm state publishes on transitions only. So the resync's
        // status_report_1 reported the same state it already knew, published
        // nothing, and the alarm card stayed blank until the panel next changed.
        it('republishes unchanged alarm state after a resync', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);

            handler.handleLine(STATUS_REPORT_1_LINE);
            const alarmPublishes = () => deps.eventPublisher.publishReading.mock.calls
                .filter(c => c[3] && c[3].kind === 'security_alarm');
            expect(alarmPublishes()).toHaveLength(1);

            // Same report again with no resync: correctly deduped.
            handler.handleLine(STATUS_REPORT_1_LINE);
            expect(alarmPublishes()).toHaveLength(1);

            // After a resync it must go out again even though nothing changed.
            handler.requestStatusSync('254', 'resync');
            handler.handleLine(STATUS_REPORT_1_LINE);
            expect(alarmPublishes()).toHaveLength(2);
        });

        it('does not republish alarm state for routine panel traffic', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.handleLine(STATUS_REPORT_1_LINE);
            const before = deps.eventPublisher.publishReading.mock.calls
                .filter(c => c[3] && c[3].kind === 'security_alarm').length;

            // A zone event triggers a 'traffic' sync, which is ordinary activity
            // rather than a request to resend, so the dedupe must still hold.
            handler.handleLine(ZONE_UNSEALED_LINE);
            handler.handleLine(STATUS_REPORT_1_LINE);

            expect(deps.eventPublisher.publishReading.mock.calls
                .filter(c => c[3] && c[3].kind === 'security_alarm')).toHaveLength(before);
        });

        it('does not let a resync consume the early or post-762 slots', () => {
            const deps = makeDeps({ cbusname: 'MIDSTRM', sendCommand: jest.fn() });
            const handler = new SecurityEventHandler(deps);
            handler.requestStatusSync('254', 'resync');
            expect(handler.requestStatusSync('254', 'connect')).toBe(true);
            expect(handler.requestStatusSync('254', 'sync')).toBe(true);
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

describe('panel state persistence', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const MAINS_FAILURE_LINE = '# security mains_failure //MIDSTRM/254/208  #sourceunit=18 OID=';

    let dir;
    let stateFile;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-panel-state-'));
        stateFile = path.join(dir, 'security-panel-state.json');
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes the panel state file when a trouble condition changes', () => {
        const handler = new SecurityEventHandler(makeDeps({ panelStateFile: stateFile }));
        handler.handleLine(MAINS_FAILURE_LINE);
        const written = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(written['254'].mains).toBe(true);
        expect(written['254'].fire).toBe(false);
    });

    it('restores panel state at construction so a restart keeps the last known conditions', () => {
        fs.writeFileSync(stateFile, JSON.stringify({ '254': { mains: true, arm_failed: true } }));
        const handler = new SecurityEventHandler(makeDeps({ panelStateFile: stateFile }));
        const states = handler.panelState.initialStates('254');
        expect(states.find((c) => c.condition === 'mains').active).toBe(true);
        expect(states.find((c) => c.condition === 'arm_failed').active).toBe(true);
        expect(states.find((c) => c.condition === 'battery').active).toBe(false);
    });

    it('tolerates a corrupt state file and starts fresh', () => {
        fs.writeFileSync(stateFile, 'not json at all {');
        const deps = makeDeps({ panelStateFile: stateFile });
        expect(() => new SecurityEventHandler(deps)).not.toThrow();
        expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read security panel state file'));
    });

    it('logs nothing and writes nothing when no state file is configured', () => {
        const handler = new SecurityEventHandler(makeDeps());
        handler.handleLine(MAINS_FAILURE_LINE);
        expect(fs.existsSync(stateFile)).toBe(false);
    });
});
