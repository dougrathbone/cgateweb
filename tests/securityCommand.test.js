'use strict';

const {
    buildSecurityStatusRequest,
    buildSecurityArmCommand,
    buildSecurityEmulateKeypadCommand,
    buildSecurityRequestZoneName
} = require('../src/securityCommand');

describe('securityCommand builders', () => {
    const base = { cbusname: 'HOME', network: 254, application: 208 };

    describe('buildSecurityArmCommand', () => {
        it.each([
            ['away'],
            ['night'],
            ['day'],
            ['vacation'],
            ['highest']
        ])('builds C-Gate arm command for mode %s', (mode) => {
            expect(buildSecurityArmCommand({ ...base, mode }))
                .toBe(`security arm //HOME/254/208 ${mode}`);
        });

        it('accepts string network and application ids', () => {
            expect(buildSecurityArmCommand({
                cbusname: 'CLIPSAL',
                network: '1',
                application: '208',
                mode: 'away'
            })).toBe('security arm //CLIPSAL/1/208 away');
        });
    });

    describe('buildSecurityStatusRequest', () => {
        it.each([
            [1, 'security status_request //HOME/254/208 1'],
            [2, 'security status_request //HOME/254/208 2']
        ])('builds status_request for report %s', (report, expected) => {
            expect(buildSecurityStatusRequest({ ...base, report })).toBe(expected);
        });
    });

    describe('buildSecurityEmulateKeypadCommand', () => {
        it.each([
            [0, '$00'],
            [1, '$01'],
            [15, '$0F'],
            [16, '$10'],
            ['1'.charCodeAt(0), '$31'],
            ['9'.charCodeAt(0), '$39'],
            ['*'.charCodeAt(0), '$2A'],
            ['#'.charCodeAt(0), '$23'],
            [127, '$7F']
        ])('encodes key %s as uppercase zero-padded $xx (%s)', (key, hex) => {
            expect(buildSecurityEmulateKeypadCommand({ ...base, key }))
                .toBe(`security emulate_keypad //HOME/254/208 ${hex}`);
        });

        it('pads single-nibble hex and uppercases a-f', () => {
            expect(buildSecurityEmulateKeypadCommand({ ...base, key: 0x0a }))
                .toBe('security emulate_keypad //HOME/254/208 $0A');
            expect(buildSecurityEmulateKeypadCommand({ ...base, key: 0xbc }))
                .toBe('security emulate_keypad //HOME/254/208 $BC');
        });
    });

    describe('buildSecurityRequestZoneName', () => {
        it('builds a C-Gate request_zone_name command', () => {
            expect(buildSecurityRequestZoneName({ ...base, zone: 12 }))
                .toBe('security request_zone_name //HOME/254/208 12');
        });
    });
});
