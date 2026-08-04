const EventEmitter = require('events');
const SseHandler = require('../src/web/sseHandler');

/**
 * Minimal req/res doubles. The interesting states are the ones a real socket
 * reaches when the peer goes away mid-stream: writableEnded/destroyed set, or
 * write() throwing outright.
 */
function makeReq() {
    return new EventEmitter();
}

function makeRes({ destroyed = false, writableEnded = false, writeThrows = false } = {}) {
    const res = new EventEmitter();
    res.destroyed = destroyed;
    res.writableEnded = writableEnded;
    res.written = [];
    res.writeHead = jest.fn();
    res.flushHeaders = jest.fn();
    res.write = jest.fn((chunk) => {
        if (writeThrows) throw new Error('write after end');
        res.written.push(chunk);
        return true;
    });
    res.end = jest.fn();
    return res;
}

function makeStream(recent = []) {
    const listeners = new Set();
    return {
        listeners,
        subscribe: (fn) => listeners.add(fn),
        unsubscribe: (fn) => listeners.delete(fn),
        getRecent: () => recent
    };
}

describe('SseHandler write guard', () => {
    // Regression for #44: Supervisor logged "Cannot write to closing transport"
    // when HA's ingress proxy dropped the socket during a backup. The socket
    // refuses writes before 'close' fires, so the close handler alone is not
    // enough — writes have to check the response themselves.

    it('does not write an event to a destroyed response', () => {
        const stream = makeStream();
        const handler = new SseHandler({ eventStream: stream, keepaliveMs: 10_000 });
        const res = makeRes();
        handler.handle(makeReq(), res);
        expect(stream.listeners.size).toBe(1);

        res.destroyed = true;
        const before = res.write.mock.calls.length;
        for (const listener of [...stream.listeners]) listener({ msg: 'after close' });

        expect(res.write.mock.calls.length).toBe(before);
    });

    it('releases the event-log listener when a write finds the response gone', () => {
        const stream = makeStream();
        const handler = new SseHandler({ eventStream: stream, keepaliveMs: 10_000 });
        const res = makeRes();
        handler.handle(makeReq(), res);

        res.writableEnded = true;
        for (const listener of [...stream.listeners]) listener({ msg: 'after end' });

        // The failed write is itself the disconnect signal, so the listener and
        // the keepalive timer go with it rather than waiting for a 'close'
        // event that may never arrive.
        expect(stream.listeners.size).toBe(0);
    });

    it('swallows a throwing write and cleans up instead of propagating', () => {
        const stream = makeStream();
        const handler = new SseHandler({ eventStream: stream, keepaliveMs: 10_000 });
        const res = makeRes();
        handler.handle(makeReq(), res);

        // Flip to throwing only after the stream is established, so the throw
        // happens on a live event rather than during replay.
        res.write = jest.fn(() => { throw new Error('Cannot write to closing transport'); });

        expect(() => {
            for (const listener of [...stream.listeners]) listener({ msg: 'boom' });
        }).not.toThrow();
        expect(stream.listeners.size).toBe(0);
    });

    it('aborts replay and never subscribes when the response is already dead', () => {
        const stream = makeStream([{ msg: 'one' }, { msg: 'two' }]);
        const handler = new SseHandler({ eventStream: stream, keepaliveMs: 10_000 });
        const res = makeRes({ destroyed: true });

        handler.handle(makeReq(), res);

        expect(res.write).not.toHaveBeenCalled();
        expect(stream.listeners.size).toBe(0);
    });

    it('still delivers replay and live events on a healthy response', () => {
        const stream = makeStream([{ msg: 'replayed' }]);
        const handler = new SseHandler({ eventStream: stream, keepaliveMs: 10_000 });
        const res = makeRes();

        handler.handle(makeReq(), res);
        for (const listener of [...stream.listeners]) listener({ msg: 'live' });

        expect(res.written.join('')).toContain('replayed');
        expect(res.written.join('')).toContain('live');
        expect(stream.listeners.size).toBe(1);
    });

    it('stops the keepalive timer once the response is gone', () => {
        jest.useFakeTimers();
        try {
            const stream = makeStream();
            const handler = new SseHandler({ eventStream: stream, keepaliveMs: 50 });
            const res = makeRes();
            handler.handle(makeReq(), res);

            jest.advanceTimersByTime(50);
            expect(res.written.join('')).toContain(': keepalive');

            res.destroyed = true;
            const after = res.write.mock.calls.length;
            jest.advanceTimersByTime(500);

            expect(res.write.mock.calls.length).toBe(after);
            expect(stream.listeners.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
