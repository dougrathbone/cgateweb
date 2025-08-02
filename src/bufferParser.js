const { NEWLINE } = require('./constants');

/**
 * Utility for parsing newline-delimited stream data
 * Handles common pattern of accumulating data in a buffer and processing complete lines
 */
class BufferParser {
    constructor(options = {}) {
        this.buffer = '';
        this.delimiter = options.delimiter || NEWLINE;
        this.trimLines = options.trimLines !== false; // Default to true
        this.skipEmptyLines = options.skipEmptyLines !== false; // Default to true
    }

    /**
     * Add new data to the buffer and process any complete lines
     * @param {Buffer|string} data - New data to add
     * @param {function} lineProcessor - Function to call for each complete line
     */
    processData(data, lineProcessor) {
        if (typeof lineProcessor !== 'function') {
            throw new Error('lineProcessor must be a function');
        }

        // Convert buffer to string and add to internal buffer
        this.buffer += data.toString();
        
        // Process all complete lines
        let delimiterIndex;
        while ((delimiterIndex = this.buffer.indexOf(this.delimiter)) > -1) {
            let line = this.buffer.substring(0, delimiterIndex);
            this.buffer = this.buffer.substring(delimiterIndex + this.delimiter.length);

            // Apply line processing options
            if (this.trimLines) {
                line = line.trim();
            }

            if (this.skipEmptyLines && !line) {
                continue;
            }

            // Process the complete line
            try {
                lineProcessor(line);
            } catch (error) {
                // Re-throw with additional context
                throw new Error(`Error processing line "${line}": ${error.message}`);
            }
        }
    }

    /**
     * Get the current buffer contents (incomplete line data)
     * @returns {string} - Current buffer contents
     */
    getBuffer() {
        return this.buffer;
    }

    /**
     * Clear the buffer
     */
    clearBuffer() {
        this.buffer = '';
    }

    /**
     * Check if buffer has any data
     * @returns {boolean} - True if buffer is not empty
     */
    hasData() {
        return this.buffer.length > 0;
    }

    /**
     * Process any remaining data in buffer as final line (useful for cleanup)
     * @param {function} lineProcessor - Function to call for remaining data
     */
    processFinalLine(lineProcessor) {
        if (this.hasData()) {
            let line = this.buffer;
            if (this.trimLines) {
                line = line.trim();
            }
            if (!this.skipEmptyLines || line) {
                lineProcessor(line);
            }
            this.clearBuffer();
        }
    }
}

/**
 * Convenience function for simple line-by-line processing
 * @param {Buffer|string} data - Data to process
 * @param {function} lineProcessor - Function to call for each line
 * @param {Object} options - Parser options
 */
function processLines(data, lineProcessor, options = {}) {
    const parser = new BufferParser(options);
    parser.processData(data, lineProcessor);
    
    // Process any remaining data as final line if requested
    if (options.processFinalLine) {
        parser.processFinalLine(lineProcessor);
    }
    
    return parser.getBuffer(); // Return any remaining buffer data
}

module.exports = {
    BufferParser,
    processLines
};