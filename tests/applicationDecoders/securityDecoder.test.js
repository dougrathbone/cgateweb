const securityDecoder = require('../../src/applicationDecoders/securityDecoder');

// Verbatim live captures from a 64-zone Cytech panel (GitHub issue #42, posted
// 2026-07-27). All lines arrive on the event port as `#`-prefixed comments.
const ZONE_UNSEALED_LINE = '# security zone_unsealed //MIDSTRM/254/208/58  #sourceunit=18 OID=';
const ZONE_SEALED_LINE = '# security zone_sealed //MIDSTRM/254/208/58  #sourceunit=18 OID=';
// Report 1: arm state 0, tamper 0, panic 0, then one exploded 2-bit value per
// zone from zone 1 — positions 30/31 (zones 27/28) are %01 = unsealed.
const STATUS_REPORT_1_LINE = '# security status_report_1 //MIDSTRM/254/208 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 0 0 0 0 #sourceunit=18 OID=';
// Report 2: no prefix, one value per zone from zone 33 (48 values = zones 33-80).
const STATUS_REPORT_2_LINE = '# security status_report_2 //MIDSTRM/254/208  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 #sourceunit=18 OID=';

describe('securityDecoder', () => {
    describe('zone events', () => {
        it('decodes zone_unsealed to an unsealed zone reading', () => {
            const r = securityDecoder.decodeLine(ZONE_UNSEALED_LINE);
            expect(r).toEqual({
                kind: 'zone',
                network: '254',
                application: '208',
                zone: '58',
                zoneState: 'unsealed',
                verb: 'zone_unsealed'
            });
        });

        it('decodes zone_sealed to a sealed zone reading', () => {
            const r = securityDecoder.decodeLine(ZONE_SEALED_LINE);
            expect(r).toMatchObject({ kind: 'zone', zone: '58', zoneState: 'sealed' });
        });

        it('decodes the spec loop-fault verbs zone_open and zone_short', () => {
            expect(securityDecoder.decodeLine('security zone_open //MIDSTRM/254/208/12'))
                .toMatchObject({ kind: 'zone', zone: '12', zoneState: 'open' });
            expect(securityDecoder.decodeLine('security zone_short //MIDSTRM/254/208/12'))
                .toMatchObject({ kind: 'zone', zone: '12', zoneState: 'short' });
        });

        it('rejects out-of-range zone numbers (valid: 1-127)', () => {
            expect(securityDecoder.decodeLine('security zone_unsealed //MIDSTRM/254/208/0')).toBeNull();
            expect(securityDecoder.decodeLine('security zone_unsealed //MIDSTRM/254/208/128')).toBeNull();
            expect(securityDecoder.decodeLine('security zone_unsealed //MIDSTRM/254/208/abc')).toBeNull();
        });

        it('rejects a zone verb with no zone in the address', () => {
            expect(securityDecoder.decodeLine('security zone_unsealed //MIDSTRM/254/208')).toBeNull();
        });
    });

    describe('status_report_1 (spec §5.5.1.20)', () => {
        it('decodes the arm/tamper/panic prefix from the live capture', () => {
            const r = securityDecoder.decodeLine(STATUS_REPORT_1_LINE);
            expect(r.kind).toBe('status_report_1');
            expect(r.network).toBe('254');
            expect(r.application).toBe('208');
            expect(r.armState).toBe(0);
            expect(r.armMode).toBe('disarmed');
            expect(r.tamper).toBe(0);
            expect(r.tamperActive).toBe(false);
            expect(r.panic).toBe(0);
            expect(r.panicActive).toBe(false);
        });

        it('decodes zones 1-32, with zones 27 and 28 unsealed in the live capture', () => {
            const r = securityDecoder.decodeLine(STATUS_REPORT_1_LINE);
            expect(r.zones).toHaveLength(32);
            expect(r.zones[0]).toEqual({ zone: 1, state: 'sealed' });
            expect(r.zones[31]).toEqual({ zone: 32, state: 'sealed' });
            const nonSealed = r.zones.filter(z => z.state !== 'sealed');
            expect(nonSealed).toEqual([
                { zone: 27, state: 'unsealed' },
                { zone: 28, state: 'unsealed' }
            ]);
        });

        it('maps all four 2-bit states (sealed/unsealed/open/short)', () => {
            // zones 1-4 = codes 0,1,2,3
            const r = securityDecoder.decodeLine('security status_report_1 //MIDSTRM/254/208 3 255 255 0 1 2 3');
            expect(r.armMode).toBe('day');
            expect(r.tamperActive).toBe(true);
            expect(r.panicActive).toBe(true);
            expect(r.zones).toEqual([
                { zone: 1, state: 'sealed' },
                { zone: 2, state: 'unsealed' },
                { zone: 3, state: 'open' },
                { zone: 4, state: 'short' }
            ]);
        });

        it('returns null for an invalid zone-state code', () => {
            expect(securityDecoder.decodeLine('security status_report_1 //MIDSTRM/254/208 0 0 0 4 0')).toBeNull();
        });

        it('returns null when the prefix is missing or non-numeric', () => {
            expect(securityDecoder.decodeLine('security status_report_1 //MIDSTRM/254/208 0 0')).toBeNull();
            expect(securityDecoder.decodeLine('security status_report_1 //MIDSTRM/254/208 x 0 0 0')).toBeNull();
        });
    });

    describe('status_report_2 (spec §5.5.1.21)', () => {
        it('decodes zones 33-80 with no prefix from the live capture', () => {
            const r = securityDecoder.decodeLine(STATUS_REPORT_2_LINE);
            expect(r.kind).toBe('status_report_2');
            expect(r.zones).toHaveLength(48);
            expect(r.zones[0]).toEqual({ zone: 33, state: 'sealed' });
            expect(r.zones[47]).toEqual({ zone: 80, state: 'sealed' });
            expect(r.zones.every(z => z.state === 'sealed')).toBe(true);
        });

        it('decodes non-sealed zones at the right offset', () => {
            // first value = zone 33 unsealed, second = zone 34 open
            const r = securityDecoder.decodeLine('security status_report_2 //MIDSTRM/254/208 1 2 0');
            expect(r.zones).toEqual([
                { zone: 33, state: 'unsealed' },
                { zone: 34, state: 'open' },
                { zone: 35, state: 'sealed' }
            ]);
        });

        it('returns null with no zone values', () => {
            expect(securityDecoder.decodeLine('security status_report_2 //MIDSTRM/254/208')).toBeNull();
        });
    });

    describe('system state verbs (phase 2 surface, decoded leniently)', () => {
        it('decodes arm_ready with no zone', () => {
            expect(securityDecoder.decodeLine('# security arm_ready //MIDSTRM/254/208  #sourceunit=18 OID='))
                .toEqual({ kind: 'arm_ready', network: '254', application: '208', verb: 'arm_ready' });
        });

        it('decodes arm_not_ready with the blocking zone', () => {
            expect(securityDecoder.decodeLine('# security arm_not_ready //MIDSTRM/254/208/44  #sourceunit=18 OID='))
                .toEqual({ kind: 'arm_not_ready', network: '254', application: '208', zone: '44', verb: 'arm_not_ready' });
        });

        it('decodes exit_delay_started', () => {
            expect(securityDecoder.decodeLine('# security exit_delay_started //MIDSTRM/254/208  #sourceunit=18 OID='))
                .toMatchObject({ kind: 'exit_delay_started' });
        });

        it('decodes system_arm modes 0-4 to their names', () => {
            const expected = { 0: 'disarmed', 1: 'away', 2: 'night', 3: 'day', 4: 'vacation' };
            for (const [mode, modeName] of Object.entries(expected)) {
                expect(securityDecoder.decodeLine(`# security system_arm //MIDSTRM/254/208 ${mode} #sourceunit=18 OID=`))
                    .toMatchObject({ kind: 'system_arm', mode: Number(mode), modeName });
            }
        });

        it('decodes an unknown system_arm mode with a null name', () => {
            expect(securityDecoder.decodeLine('security system_arm //MIDSTRM/254/208 9'))
                .toMatchObject({ kind: 'system_arm', mode: 9, modeName: null });
        });

        it('decodes arm_failed with its free-text argument', () => {
            expect(securityDecoder.decodeLine('# security arm_failed //MIDSTRM/254/208 arm_failed_raised #sourceunit=18 OID='))
                .toMatchObject({ kind: 'arm_failed', detail: 'arm_failed_raised' });
        });

        it('decodes alarm_on and alarm_off', () => {
            expect(securityDecoder.decodeLine('# security alarm_on //MIDSTRM/254/208  #sourceunit=18 OID='))
                .toMatchObject({ kind: 'alarm_on' });
            expect(securityDecoder.decodeLine('# security alarm_off //MIDSTRM/254/208  #sourceunit=18 OID='))
                .toMatchObject({ kind: 'alarm_off' });
        });

        it('decodes zone_isolated with the bypassed zone', () => {
            expect(securityDecoder.decodeLine('# security zone_isolated //MIDSTRM/254/208/44  #sourceunit=18 OID='))
                .toMatchObject({ kind: 'zone_isolated', zone: '44' });
        });

        it('decodes fire_alarm with its free-text argument', () => {
            expect(securityDecoder.decodeLine('# security fire_alarm //MIDSTRM/254/208 fire_alarm_raised #sourceunit=18 OID='))
                .toMatchObject({ kind: 'fire_alarm', detail: 'fire_alarm_raised' });
        });
    });

    describe('rejected input', () => {
        it('returns null for non-security lines', () => {
            expect(securityDecoder.decodeLine('lighting on //MIDSTRM/254/56/4')).toBeNull();
            expect(securityDecoder.decodeLine('# some other comment')).toBeNull();
            expect(securityDecoder.decodeLine('aircon zone_temperature //MIDSTRM/254/172 1 0 4431')).toBeNull();
        });

        it('returns null for unknown security verbs', () => {
            expect(securityDecoder.decodeLine('security some_unknown_verb //MIDSTRM/254/208 1')).toBeNull();
        });

        it('returns null for malformed input', () => {
            expect(securityDecoder.decodeLine(null)).toBeNull();
            expect(securityDecoder.decodeLine(undefined)).toBeNull();
            expect(securityDecoder.decodeLine(42)).toBeNull();
            expect(securityDecoder.decodeLine('security zone_unsealed')).toBeNull();
            expect(securityDecoder.decodeLine('security zone_unsealed not-an-address')).toBeNull();
        });
    });

    describe('exports', () => {
        it('exposes the default app id and zone-state constants', () => {
            expect(securityDecoder.appId).toBe('208');
            expect(securityDecoder.ZONE_STATE).toEqual({
                SEALED: 'sealed', UNSEALED: 'unsealed', OPEN: 'open', SHORT: 'short'
            });
            expect(securityDecoder.ZONE_STATE_BY_CODE).toEqual(['sealed', 'unsealed', 'open', 'short']);
            expect(securityDecoder.ARM_MODE_BY_CODE[0]).toBe('disarmed');
        });
    });
});
