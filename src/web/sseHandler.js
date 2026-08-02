// @ts-check
const { sendJSON } = require('./httpHelpers');

/**
 * Server-sent events handler for GET /api/events/stream.
 */
class SseHandler {
    /**
     * @param {Object} options
     * @param {Object|null} options.eventStream - Event stream instance (subscribe/unsubscribe/getRecent)
     * @param {number} [options.keepaliveMs=15000] - Keepalive comment interval
     * @param {number} [options.maxConnections=32] - Maximum concurrent SSE clients
     */
    constructor({ eventStream = null, keepaliveMs = 15000, maxConnections = 32 }) {
        this.eventStream = eventStream;
        this.keepaliveMs = keepaliveMs;
        this.maxConnections = maxConnections;
        // Live connections, each { res, listener, keepaliveInterval }. Tracked
        // so closeAll() can release event-log listeners and keepalive timers
        // deterministically on server shutdown instead of relying on the
        // socket close events that never arrive for an idle SSE stream.
        this._connections = new Set();
    }

    /**
     * Stream recent events followed by live events until the client disconnects.
     */
    handle(req, res) {
        if (this._connections.size >= this.maxConnections) {
            return sendJSON(res, 503, { error: 'Too many event stream connections' });
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        // Flush headers immediately so the client knows the connection is open
        if (res.flushHeaders) res.flushHeaders();

        // Replay recent events first
        if (this.eventStream) {
            const recent = this.eventStream.getRecent();
            for (const entry of recent) {
                res.write(`data: ${JSON.stringify(entry)}\n\n`);
            }
        }

        // Listener for new events
        const listener = (entry) => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        };

        if (this.eventStream) {
            this.eventStream.subscribe(listener);
        }

        // Keepalive comment every 15 seconds to prevent proxy timeouts
        const keepaliveInterval = setInterval(() => {
            res.write(': keepalive\n\n');
        }, this.keepaliveMs);
        keepaliveInterval.unref();

        const connection = { res, listener, keepaliveInterval };
        this._connections.add(connection);

        // Clean up on client disconnect or response failure — listen on both
        // req and res so a destroyed response can't leak the event-log
        // listener and keepalive timer.
        const cleanup = () => {
            if (!this._connections.delete(connection)) return; // already cleaned up
            clearInterval(keepaliveInterval);
            if (this.eventStream) {
                this.eventStream.unsubscribe(listener);
            }
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
    }

    /**
     * End every live SSE response and release its listener and keepalive
     * timer. Called on server shutdown; safe to call with no clients.
     */
    closeAll() {
        for (const connection of [...this._connections]) {
            this._connections.delete(connection);
            clearInterval(connection.keepaliveInterval);
            if (this.eventStream) {
                this.eventStream.unsubscribe(connection.listener);
            }
            try {
                connection.res.end();
            } catch { /* already closed */ }
        }
    }
}

module.exports = SseHandler;
