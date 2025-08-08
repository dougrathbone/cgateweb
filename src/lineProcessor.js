const readline = require('readline');
const { PassThrough } = require('stream');
const { NEWLINE } = require('./constants');

/**
 * A line processor that uses Node.js built-in readline interface to process lines
 * Replaces the custom BufferParser with standard Node.js functionality
 */
class LineProcessor {
    constructor(options = {}) {
        this.options = {
            delimiter: options.delimiter || NEWLINE,
            trimLines: options.trimLines !== false, // Default to true
            skipEmptyLines: options.skipEmptyLines !== false // Default to true
        };
        
        this.stream = new PassThrough();
        this.lineProcessor = null;
        
        // Create readline interface
        this.rl = readline.createInterface({
            input: this.stream,
            crlfDelay: Infinity
        });
        
        // Set up line handling
        this.rl.on('line', (line) => {
            this._processLine(line);
        });
        
        this.rl.on('error', (error) => {
            // Re-throw with additional context if we have a line processor
            if (this.lineProcessor) {
                throw new Error(`Error in line processing: ${error.message}`);
            }
            throw error;
        });
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
        
        // Write data to the stream, which will trigger line events
        this.stream.write(data);
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
        
        // Apply line processing options
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
        if (this.rl) {
            this.rl.close();
        }
        if (this.stream) {
            this.stream.end();
        }
    }
    
    // Compatibility methods for existing BufferParser interface
    
    /**
     * Get any remaining data (not applicable to stream-based processing)
     * Returns empty string for compatibility
     * @returns {string} - Always returns empty string
     */
    getBuffer() {
        return '';
    }
    
    /**
     * Check if there's remaining data (not applicable to stream-based processing)
     * @returns {boolean} - Always returns false
     */
    hasData() {
        return false;
    }
    
    /**
     * Clear buffer (no-op for stream-based processing)
     */
    clearBuffer() {
        // No-op for streams
    }
    
    /**
     * Process final line (no-op for stream-based processing since readline handles this)
     * @param {function} _lineProcessor - Not used
     */
    processFinalLine(_lineProcessor) {
        // No-op for streams - readline handles incomplete lines automatically
    }
}

/**
 * Convenience function for simple line-by-line processing
 * Uses Node.js streams instead of custom buffer management
 * @param {Buffer|string} data - Data to process
 * @param {function} lineProcessor - Function to call for each line
 * @param {Object} options - Processor options
 * @returns {string} - Empty string for compatibility (streams don't have remaining buffer)
 */
function processLines(data, lineProcessor, options = {}) {
    const processor = new LineProcessor(options);
    
    // Set up the line processor
    processor.processData(data, lineProcessor);
    
    // For streams, we need to end the stream to ensure all data is processed
    processor.stream.end();
    
    // Clean up
    processor.close();
    
    return ''; // Return empty string for compatibility
}

module.exports = {
    LineProcessor,
    processLines
};
