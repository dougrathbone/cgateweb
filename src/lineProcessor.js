const { NEWLINE } = require('./constants');

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
        this._buffer += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

        const buffer = this._buffer;
        const delimiter = this.options.delimiter;
        const delimiterLength = delimiter.length;
        let searchStart = 0;
        let delimiterIndex = buffer.indexOf(delimiter, searchStart);

        while (delimiterIndex !== -1) {
            const rawLine = buffer.slice(searchStart, delimiterIndex);
            searchStart = delimiterIndex + delimiterLength;
            // Preserve existing semantics for re-entrant callbacks (e.g. close()).
            this._buffer = buffer.slice(searchStart);

            try {
                this._processLine(rawLine);
            } catch (error) {
                throw error;
            }

            delimiterIndex = buffer.indexOf(delimiter, searchStart);
        }

        if (searchStart === 0) {
            this._buffer = buffer;
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
            throw new Error(`Error processing line "${line}": ${error.message}`);
        }
    }
    
    /**
     * Close the line processor and clean up resources
     */
    close() {
        if (this._buffer && this.lineProcessor) {
            this._processLine(this._buffer);
        }
        this._buffer = '';
        this.lineProcessor = null;
    }
    
    // Compatibility methods for existing BufferParser interface
    
    /**
     * Get any remaining buffered partial line.
     * @returns {string} Remaining unprocessed partial line
     */
    getBuffer() {
        return this._buffer;
    }
    
    /**
     * Check if there's remaining buffered partial line data.
     * @returns {boolean}
     */
    hasData() {
        return this._buffer.length > 0;
    }
    
    /**
     * Clear buffered partial line.
     */
    clearBuffer() {
        this._buffer = '';
    }
    
    /**
     * Process the final line if there is buffered data.
     * @param {function} lineProcessor - Optional line processor callback
     */
    processFinalLine(lineProcessor) {
        if (typeof lineProcessor === 'function') {
            this.lineProcessor = lineProcessor;
        }

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
