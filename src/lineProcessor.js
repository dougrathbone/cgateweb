// @ts-check
const { NEWLINE } = require('./constants');

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB — no valid C-Gate line approaches this

/**
 * A lightweight line processor optimized for hot-path socket data.
 */
class LineProcessor {
    constructor(options = {}) {
        this.options = {
            delimiter: options.delimiter || NEWLINE,
            trimLines: options.trimLines !== false, // Default to true
            skipEmptyLines: options.skipEmptyLines !== false // Default to true
        };

        this.lineProcessor = null;
        this._buffer = '';
        // Leading characters of _buffer already consumed by processData. Kept
        // as an offset during the line loop so each completed line costs an
        // integer assignment instead of re-slicing the remaining buffer;
        // materialized back into _buffer at the end of the loop and lazily by
        // every public accessor (see _materializeBuffer).
        this._bufferOffset = 0;
    }

    /**
     * Fold a pending offset back into _buffer. Runs at the top of processData
     * (a re-entrant call from a line callback must see the true remainder)
     * and in every public accessor, so the offset is only ever observable
     * mid-loop — e.g. a callback calling close() still sees the remainder.
     * @private
     */
    _materializeBuffer() {
        if (this._bufferOffset > 0) {
            this._buffer = this._buffer.slice(this._bufferOffset);
            this._bufferOffset = 0;
        }
    }

    /**
     * Process incoming data by writing it to the stream
     * @param {Buffer|string} data - New data to process
     * @param {function} lineProcessor - Function to call for each complete line
     */
    processData(data, lineProcessor) {
        if (typeof lineProcessor !== 'function') {
            throw new Error('lineProcessor must be a function');
        }

        this.lineProcessor = lineProcessor;
        this._materializeBuffer();
        this._buffer += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

        // Prevent unbounded buffer growth from malformed data without newlines
        if (this._buffer.length > MAX_BUFFER_SIZE) {
            this._buffer = this._buffer.slice(-MAX_BUFFER_SIZE);
        }

        const buffer = this._buffer;
        const delimiter = this.options.delimiter;
        const delimiterLength = delimiter.length;
        let searchStart = 0;
        let delimiterIndex = buffer.indexOf(delimiter, searchStart);

        while (delimiterIndex !== -1) {
            const rawLine = buffer.slice(searchStart, delimiterIndex);
            searchStart = delimiterIndex + delimiterLength;
            // Preserve existing semantics for re-entrant callbacks (e.g. close()):
            // the remainder is visible via the offset, not a per-line slice.
            this._bufferOffset = searchStart;

            this._processLine(rawLine);

            delimiterIndex = buffer.indexOf(delimiter, searchStart);
        }

        // One slice per chunk with at least one completed line (vs one per
        // line) — after this the offset is zero and _buffer is the remainder.
        if (searchStart > 0) {
            this._buffer = buffer.slice(searchStart);
            this._bufferOffset = 0;
        }
    }
    
    /**
     * Process a line according to our options and call the line processor
     * @param {string} line - The line to process
     * @private
     */
    _processLine(line) {
        if (!this.lineProcessor) {
            return; // No processor set
        }
        
        // Handle CRLF line endings even when delimiter is '\n'.
        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }

        if (this.options.trimLines) {
            line = line.trim();
        }
        
        if (this.options.skipEmptyLines && !line) {
            return;
        }
        
        // Process the complete line
        try {
            this.lineProcessor(line);
        } catch (error) {
            // Re-throw with additional context
            throw new Error(`Error processing line "${line}": ${error.message}`, { cause: error });
        }
    }
    
    /**
     * Close the line processor and clean up resources
     */
    close() {
        this._materializeBuffer();
        if (this._buffer && this.lineProcessor) {
            this._processLine(this._buffer);
        }
        this._buffer = '';
        this._bufferOffset = 0;
        this.lineProcessor = null;
    }

    // Compatibility methods for existing BufferParser interface

    /**
     * Get any remaining buffered partial line.
     * @returns {string} Remaining unprocessed partial line
     */
    getBuffer() {
        this._materializeBuffer();
        return this._buffer;
    }

    /**
     * Check if there's remaining buffered partial line data.
     * @returns {boolean}
     */
    hasData() {
        this._materializeBuffer();
        return this._buffer.length > 0;
    }

    /**
     * Clear buffered partial line.
     */
    clearBuffer() {
        this._buffer = '';
        this._bufferOffset = 0;
    }

    /**
     * Process the final line if there is buffered data.
     * @param {function} lineProcessor - Optional line processor callback
     */
    processFinalLine(lineProcessor) {
        if (typeof lineProcessor === 'function') {
            this.lineProcessor = lineProcessor;
        }

        this._materializeBuffer();
        if (this._buffer) {
            this._processLine(this._buffer);
            this._buffer = '';
        }
    }
}

/**
 * Convenience function for simple line-by-line processing.
 * @param {Buffer|string} data - Data to process
 * @param {function} lineProcessor - Function to call for each line
 * @param {Object} options - Processor options
 * @returns {string} - Remaining partial line buffer
 */
function processLines(data, lineProcessor, options = {}) {
    const processor = new LineProcessor(options);
    processor.processData(data, lineProcessor);
    const remaining = processor.getBuffer();
    processor.clearBuffer();
    processor.close();
    return remaining;
}

module.exports = {
    LineProcessor,
    processLines
};
