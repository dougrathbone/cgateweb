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
        this._activeConnections = 0;
    }

    /**
     * Stream recent events followed by live events until the client disconnects.
     */
    handle(req, res) {
        if (this._activeConnections >= this.maxConnections) {
            return sendJSON(res, 503, { error: 'Too many event stream connections' });
        }
        this._activeConnections += 1;

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

        // Clean up on client disconnect
        req.on('close', () => {
            clearInterval(keepaliveInterval);
            this._activeConnections = Math.max(0, this._activeConnections - 1);
            if (this.eventStream) {
                this.eventStream.unsubscribe(listener);
            }
        });
    }
}

module.exports = SseHandler;
