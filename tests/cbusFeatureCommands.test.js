'use strict';

const { buildClockRequestRefresh } = require('../src/clockCommand');
const { buildTemperatureBroadcastCommand, celsiusToTemperatureBroadcastByte } = require('../src/temperatureCommand');

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
