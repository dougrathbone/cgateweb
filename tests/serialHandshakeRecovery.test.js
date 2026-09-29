'use strict';

const SerialHandshakeRecovery = require('../src/serialHandshakeRecovery');

const OPENING = { interfaceState: 'opening', state: 'new' };
const RUNNING = { interfaceState: 'running', state: 'ok' };

function makeRecovery(settingsOverrides = {}) {
    let clock = 0;
    const sendCommand = jest.fn();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const recovery = new SerialHandshakeRecovery({
        settings: {
            cbusname: 'HOME',
            cgate_mode: 'managed',
            cgate_serial_device: '/dev/serial/by-id/usb-1a86_USB2.0-Ser_-if00-port0',
            serialHandshakeRetryAfterMs: 45000,
            serialHandshakeMaxAttempts: 3,
            serialHandshakeReopenDelayMs: 2000,
            ...settingsOverrides
        },
        logger,
        sendCommand,
        now: () => clock
    });
    const advance = (ms) => {
        clock += ms;
        jest.advanceTimersByTime(ms);
    };
    return { recovery, sendCommand, logger, advance };
}

/** Poll every 30s for `ms`, reporting the network as still opening. */
function pollOpening(recovery, advance, ms) {
    for (let t = 0; t < ms; t += 30000) {
        advance(30000);
        recovery.handleReading('254', OPENING);
    }
}

describe('SerialHandshakeRecovery', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('does nothing without a serial device', () => {
        const { recovery, sendCommand, advance } = makeRecovery({ cgate_serial_device: null });
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 600000);
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('does nothing in remote mode', () => {
        const { recovery, sendCommand, advance } = makeRecovery({ cgate_mode: 'remote' });
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 600000);
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
        const { recovery, sendCommand, advance } = makeRecovery({ serialHandshakeEnabled: false });
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 600000);
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('closes then reopens the network once it has been opening past the threshold', () => {
        const { recovery, sendCommand, advance } = makeRecovery();
        expect(recovery.handleReading('254', OPENING)).toBe('waiting');
        advance(30000);
        expect(recovery.handleReading('254', OPENING)).toBe('waiting');
        expect(sendCommand).not.toHaveBeenCalled();

        advance(30000);
        expect(recovery.handleReading('254', OPENING)).toBe('reopened');
        expect(sendCommand).toHaveBeenCalledTimes(1);
        expect(sendCommand).toHaveBeenCalledWith('NET CLOSE //HOME/254\n');

        advance(2000);
        expect(sendCommand).toHaveBeenCalledTimes(2);
        expect(sendCommand).toHaveBeenLastCalledWith('NET OPEN //HOME/254\n');
    });

    it('treats opening with no State reading yet as stuck', () => {
        const { recovery, sendCommand, advance } = makeRecovery();
        recovery.handleReading('254', { interfaceState: 'opening', state: null });
        advance(60000);
        expect(recovery.handleReading('254', { interfaceState: 'opening', state: null })).toBe('reopened');
        expect(sendCommand).toHaveBeenCalledWith('NET CLOSE //HOME/254\n');
    });

    it('ignores an interface that is opening mid-sync or closed', () => {
        const { recovery, sendCommand, advance } = makeRecovery();
        recovery.handleReading('254', { interfaceState: 'opening', state: 'sync' });
        advance(60000);
        recovery.handleReading('254', { interfaceState: 'opening', state: 'sync' });
        recovery.handleReading('254', { interfaceState: 'closed', state: 'new' });
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('gives up after the attempt cap and logs it once', () => {
        const { recovery, sendCommand, logger, advance } = makeRecovery();
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 30 * 60000);

        const closes = sendCommand.mock.calls.filter(([cmd]) => cmd.startsWith('NET CLOSE'));
        expect(closes).toHaveLength(3);
        const gaveUp = logger.error.mock.calls.filter(([msg]) => /never finished opening/.test(msg));
        expect(gaveUp).toHaveLength(1);
    });

    it('backs off between attempts', () => {
        const { recovery, sendCommand, advance } = makeRecovery({ serialHandshakeMaxAttempts: 5 });
        const closeTimes = [];
        let elapsed = 0;
        recovery.handleReading('254', OPENING);
        for (let i = 0; i < 40; i++) {
            advance(15000);
            elapsed += 15000;
            const before = sendCommand.mock.calls.length;
            recovery.handleReading('254', OPENING);
            if (sendCommand.mock.calls.length > before) closeTimes.push(elapsed);
        }
        const gaps = closeTimes.slice(1).map((t, i) => t - closeTimes[i]);
        expect(gaps[1]).toBeGreaterThan(gaps[0]);
        expect(gaps[2]).toBeGreaterThan(gaps[1]);
    });

    it('resets the budget when the interface reaches running', () => {
        const { recovery, sendCommand, logger, advance } = makeRecovery({ serialHandshakeMaxAttempts: 1 });
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 60000);
        advance(2000);
        expect(sendCommand).toHaveBeenCalledTimes(2);

        expect(recovery.handleReading('254', RUNNING)).toBe('recovered');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('finished opening after 1 reopen attempt'));

        sendCommand.mockClear();
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 60000);
        expect(sendCommand).toHaveBeenCalledWith('NET CLOSE //HOME/254\n');
    });

    it('cancels a pending reopen on stop', () => {
        const { recovery, sendCommand, advance } = makeRecovery();
        recovery.handleReading('254', OPENING);
        pollOpening(recovery, advance, 60000);
        expect(sendCommand).toHaveBeenCalledTimes(1);
        recovery.stop();
        advance(5000);
        expect(sendCommand).toHaveBeenCalledTimes(1);
    });
});
