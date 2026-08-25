'use strict';

const { buildClockRequestRefresh } = require('../src/clockCommand');
const { buildTemperatureBroadcastCommand, celsiusToTemperatureBroadcastByte } = require('../src/temperatureCommand');
const { buildScenePlayCommand, buildSceneRecordCommand } = require('../src/sceneCommand');
const {
    buildEnableSetCommand,
    buildEnableLabelCommand,
    buildEnableRemoveCommand,
    encodeUtf8ToCgateHex
} = require('../src/enableCommand');

describe('clockCommand', () => {
    it('builds CLOCK REQUEST_REFRESH for the network clock app', () => {
        expect(buildClockRequestRefresh({ cbusname: 'HOME', network: 254 }))
            .toBe('clock request_refresh //HOME/254/223');
    });
});

describe('temperatureCommand', () => {
    it('encodes 21.5 °C as raw 86', () => {
        expect(celsiusToTemperatureBroadcastByte(21.5)).toBe(86);
        expect(buildTemperatureBroadcastCommand({
            cbusname: 'HOME', network: 254, application: 25, group: 3, rawByte: 86
        })).toBe('TEMPERATURE BROADCAST //HOME/254/25/3 86');
    });

    it('rejects values outside 0–63.75 °C', () => {
        expect(celsiusToTemperatureBroadcastByte(-0.1)).toBeNull();
        expect(celsiusToTemperatureBroadcastByte(64)).toBeNull();
        expect(celsiusToTemperatureBroadcastByte(Number.NaN)).toBeNull();
    });
});

describe('sceneCommand', () => {
    it('builds play and record commands', () => {
        expect(buildScenePlayCommand({ set: 1, scene: 4 })).toBe('scene play 1 4');
        expect(buildSceneRecordCommand({ set: 1, scene: 4 })).toBe('scene record 1 4');
    });
});

describe('enableCommand', () => {
    const base = { cbusname: 'HOME', network: 254, application: 203, group: 7 };

    it('builds ENABLE SET with a native 0–255 byte', () => {
        expect(buildEnableSetCommand({ ...base, payload: '128' }))
            .toEqual({ ok: true, command: 'enable set //HOME/254/203/7 128' });
        expect(buildEnableSetCommand({ ...base, payload: 'ON' }))
            .toEqual({ ok: true, command: 'enable set //HOME/254/203/7 255' });
        expect(buildEnableSetCommand({ ...base, payload: 'off' }))
            .toEqual({ ok: true, command: 'enable set //HOME/254/203/7 0' });
    });

    it('rejects SET values outside 0–255', () => {
        expect(buildEnableSetCommand({ ...base, payload: '256' }).ok).toBe(false);
        expect(buildEnableSetCommand({ ...base, payload: '-1' }).ok).toBe(false);
        expect(buildEnableSetCommand({ ...base, payload: '1.5' }).ok).toBe(false);
        expect(buildEnableSetCommand({ ...base, payload: '' }).ok).toBe(false);
    });

    it('hex-encodes LABEL text and keeps group out of the object path', () => {
        expect(encodeUtf8ToCgateHex('Hello')).toBe('48 65 6C 6C 6F');
        expect(buildEnableLabelCommand({ ...base, payload: 'Hello' }))
            .toEqual({ ok: true, command: 'enable label //HOME/254/203 1 7 hex 48 65 6C 6C 6F' });
        expect(buildEnableLabelCommand({ ...base, payload: 'a#b' }).command)
            .toContain('hex 61 23 62');
    });

    it('clips LABEL to 32 characters and rejects empty labels', () => {
        const long = 'a'.repeat(33);
        const result = buildEnableLabelCommand({ ...base, payload: long });
        expect(result.ok).toBe(true);
        expect(result.command).toMatch(/hex (?:61 ){31}61$/);
        expect(buildEnableLabelCommand({ ...base, payload: '   ' }).ok).toBe(false);
    });

    it('builds ENABLE REMOVE only when the payload is ON', () => {
        expect(buildEnableRemoveCommand({ ...base, payload: 'ON' }))
            .toEqual({ ok: true, command: 'enable remove //HOME/254/203/7' });
        expect(buildEnableRemoveCommand({ ...base, payload: '' }).ok).toBe(false);
        expect(buildEnableRemoveCommand({ ...base, payload: 'OFF' }).ok).toBe(false);
    });
});
