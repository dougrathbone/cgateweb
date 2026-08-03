const SecurityPanelState = require('../src/securityPanelState');

describe('SecurityPanelState', () => {
    let state;

    beforeEach(() => {
        state = new SecurityPanelState();
    });

    const trouble = (condition, active, network = '254') => ({
        kind: 'panel_trouble', network, condition, active
    });

    const activeFor = (tracker, network, condition) =>
        tracker.initialStates(network).find((c) => c.condition === condition).active;

    describe('transitions', () => {
        it('reports a newly raised condition as changed', () => {
            expect(state.applyReading(trouble('mains', true)))
                .toEqual([{ condition: 'mains', active: true }]);
        });

        it('dedupes a repeated raise', () => {
            state.applyReading(trouble('mains', true));
            expect(state.applyReading(trouble('mains', true))).toEqual([]);
        });

        it('reports the clear that follows a raise', () => {
            state.applyReading(trouble('mains', true));
            expect(state.applyReading(trouble('mains', false)))
                .toEqual([{ condition: 'mains', active: false }]);
        });

        it('dedupes a clear for a condition that was never raised', () => {
            expect(state.applyReading(trouble('mains', false))).toEqual([]);
        });

        it('tracks networks independently', () => {
            state.applyReading(trouble('mains', true, '254'));
            expect(state.applyReading(trouble('mains', true, '200')))
                .toEqual([{ condition: 'mains', active: true }]);
        });

        it('ignores an unknown condition', () => {
            expect(state.applyReading(trouble('not_a_condition', true))).toEqual([]);
        });
    });

    describe('derived clears', () => {
        it('clears panic, arm_failed and fire on disarm', () => {
            for (const condition of ['panic', 'arm_failed', 'fire']) {
                state.applyReading(trouble(condition, true));
            }
            const cleared = state.applyReading({ kind: 'system_arm', network: '254', mode: 0 });
            expect(cleared.map((c) => c.condition).sort()).toEqual(['arm_failed', 'fire', 'panic']);
            expect(cleared.every((c) => c.active === false)).toBe(true);
        });

        it('leaves mains and battery alone on disarm - a power fault is not cleared by disarming', () => {
            state.applyReading(trouble('mains', true));
            state.applyReading(trouble('battery', true));
            expect(state.applyReading({ kind: 'system_arm', network: '254', mode: 0 })).toEqual([]);
            expect(activeFor(state, '254', 'mains')).toBe(true);
        });

        it('clears arm_failed on a successful arm but leaves panic alone', () => {
            state.applyReading(trouble('arm_failed', true));
            state.applyReading(trouble('panic', true));
            expect(state.applyReading({ kind: 'system_arm', network: '254', mode: 1 }))
                .toEqual([{ condition: 'arm_failed', active: false }]);
            expect(activeFor(state, '254', 'panic')).toBe(true);
        });

        it('reports nothing when a disarm has nothing to clear', () => {
            expect(state.applyReading({ kind: 'system_arm', network: '254', mode: 0 })).toEqual([]);
        });
    });

    describe('status report seeding', () => {
        it('seeds tamper and panic from the report bytes', () => {
            expect(state.seedFromStatusReport({
                kind: 'status_report_1', network: '254', tamperActive: true, panicActive: false
            })).toEqual([{ condition: 'tamper', active: true }]);
            expect(activeFor(state, '254', 'tamper')).toBe(true);
        });

        it('seeds both when both are active', () => {
            const seeded = state.seedFromStatusReport({
                kind: 'status_report_1', network: '254', tamperActive: true, panicActive: true
            });
            expect(seeded.map((c) => c.condition).sort()).toEqual(['panic', 'tamper']);
        });

        it('corrects an assumed-healthy seed when the first report says otherwise', () => {
            state.initialStates('254');
            expect(state.seedFromStatusReport({
                kind: 'status_report_1', network: '254', tamperActive: true, panicActive: false
            })).toEqual([{ condition: 'tamper', active: true }]);
        });

        it('ignores reports that carry no tamper or panic bytes', () => {
            expect(state.seedFromStatusReport({ kind: 'status_report_2', network: '254' })).toEqual([]);
        });
    });

    describe('initialStates', () => {
        it('returns all seven conditions defaulting to inactive', () => {
            const initial = state.initialStates('254');
            expect(initial).toHaveLength(7);
            expect(initial.map((c) => c.condition)).toEqual(
                ['mains', 'battery', 'tamper', 'panic', 'line', 'arm_failed', 'fire']
            );
            expect(initial.every((c) => c.active === false)).toBe(true);
        });

        it('reflects state already learned from a status report', () => {
            state.seedFromStatusReport({
                kind: 'status_report_1', network: '254', tamperActive: true, panicActive: false
            });
            const initial = state.initialStates('254');
            expect(initial.find((c) => c.condition === 'tamper').active).toBe(true);
            expect(initial.find((c) => c.condition === 'panic').active).toBe(false);
        });
    });

});

describe('persistence (toJSON / restore)', () => {
    const trouble = (condition, active, network = '254') => ({
        kind: 'panel_trouble', network, condition, active
    });

    it('round-trips learned conditions through toJSON and restore', () => {
        const tracker = new SecurityPanelState();
        tracker.applyReading(trouble('mains', true));
        tracker.applyReading(trouble('arm_failed', true));
        tracker.applyReading(trouble('mains', true, '253'));

        const restored = new SecurityPanelState();
        restored.restore(JSON.parse(JSON.stringify(tracker.toJSON())));

        const states254 = restored.initialStates('254');
        expect(states254.find((c) => c.condition === 'mains').active).toBe(true);
        expect(states254.find((c) => c.condition === 'arm_failed').active).toBe(true);
        expect(states254.find((c) => c.condition === 'battery').active).toBe(false);
        expect(restored.initialStates('253').find((c) => c.condition === 'mains').active).toBe(true);
    });

    it('ignores unknown conditions and non-boolean values in the file', () => {
        const restored = new SecurityPanelState();
        restored.restore({
            '254': { mains: true, wat: true, battery: 'yes', tamper: true }
        });
        const states = restored.initialStates('254');
        expect(states.find((c) => c.condition === 'mains').active).toBe(true);
        expect(states.find((c) => c.condition === 'tamper').active).toBe(true);
        // 'wat' is not a known condition and 'yes' is not a boolean: both ignored.
        expect(states).toHaveLength(7);
        expect(states.find((c) => c.condition === 'battery').active).toBe(false);
    });

    it('tolerates null, non-object, and malformed network entries', () => {
        const restored = new SecurityPanelState();
        expect(() => {
            restored.restore(null);
            restored.restore('junk');
            restored.restore({ '254': null, '253': 'junk' });
        }).not.toThrow();
        expect(restored.initialStates('254').every((c) => c.active === false)).toBe(true);
    });
});

describe('SecurityPanelState — alarm panel state (applyAlarmReading)', () => {
    let state;

    beforeEach(() => {
        state = new SecurityPanelState();
    });

    const reading = (kind, extra = {}, network = '254') => ({ kind, network, ...extra });

    it('maps system_arm modes to HA alarm states', () => {
        const expected = { 0: 'disarmed', 1: 'armed_away', 2: 'armed_night', 3: 'armed_home', 4: 'armed_vacation' };
        for (const [mode, alarmState] of Object.entries(expected)) {
            const tracker = new SecurityPanelState();
            expect(tracker.applyAlarmReading(reading('system_arm', { mode: Number(mode) })))
                .toEqual({ state: alarmState, blockingZone: null });
        }
    });

    it('seeds the state from a status_report_1 arm-state prefix', () => {
        expect(state.applyAlarmReading(reading('status_report_1', { armState: 3 })))
            .toEqual({ state: 'armed_home', blockingZone: null });
    });

    it('dedupes repeated states (transitions only)', () => {
        state.applyAlarmReading(reading('system_arm', { mode: 1 }));
        expect(state.applyAlarmReading(reading('system_arm', { mode: 1 }))).toBeNull();
    });

    it('walks the captured arm sequence: arm_ready → exit_delay → system_arm', () => {
        expect(state.applyAlarmReading(reading('arm_ready'))).toEqual({ state: 'disarmed', blockingZone: null });
        expect(state.applyAlarmReading(reading('exit_delay_started'))).toEqual({ state: 'arming', blockingZone: null });
        expect(state.applyAlarmReading(reading('system_arm', { mode: 3 }))).toEqual({ state: 'armed_home', blockingZone: null });
    });

    it('arm_not_ready goes pending with the blocking zone, and re-publishes when the zone changes', () => {
        expect(state.applyAlarmReading(reading('arm_not_ready', { zone: '44' })))
            .toEqual({ state: 'pending', blockingZone: '44' });
        // Same zone again: deduped
        expect(state.applyAlarmReading(reading('arm_not_ready', { zone: '44' }))).toBeNull();
        // A different blocking zone while still pending: new transition
        expect(state.applyAlarmReading(reading('arm_not_ready', { zone: '45' })))
            .toEqual({ state: 'pending', blockingZone: '45' });
    });

    it('alarm_on goes triggered and alarm_off reverts to the pre-alarm state', () => {
        state.applyAlarmReading(reading('system_arm', { mode: 1 }));
        expect(state.applyAlarmReading(reading('alarm_on'))).toEqual({ state: 'triggered', blockingZone: null });
        expect(state.applyAlarmReading(reading('alarm_off'))).toEqual({ state: 'armed_away', blockingZone: null });
    });

    it('alarm_off with no trackable pre-alarm state stays quiet (the next system_arm re-derives it)', () => {
        state.applyAlarmReading(reading('alarm_on'));
        expect(state.applyAlarmReading(reading('alarm_off'))).toBeNull();
    });

    it('triggered state survives arm_ready noise until a system_arm re-derives', () => {
        state.applyAlarmReading(reading('system_arm', { mode: 1 }));
        state.applyAlarmReading(reading('alarm_on'));
        expect(state.applyAlarmReading(reading('arm_ready'))).toEqual({ state: 'disarmed', blockingZone: null });
    });

    it('ignores readings that carry no alarm state', () => {
        expect(state.applyAlarmReading(reading('zone', { zone: '35' }))).toBeNull();
        expect(state.applyAlarmReading(reading('status_report_2'))).toBeNull();
        expect(state.applyAlarmReading(null)).toBeNull();
    });

    it('ignores unknown arm modes', () => {
        expect(state.applyAlarmReading(reading('system_arm', { mode: 9 }))).toBeNull();
    });

    it('tracks networks independently', () => {
        state.applyAlarmReading(reading('system_arm', { mode: 1 }, '254'));
        expect(state.applyAlarmReading(reading('system_arm', { mode: 3 }, '255')))
            .toEqual({ state: 'armed_home', blockingZone: null });
    });
});
