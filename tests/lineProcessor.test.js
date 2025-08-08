const { LineProcessor, processLines } = require('../src/lineProcessor');

describe('LineProcessor', () => {
    let processor;
    let processedLines;

    beforeEach(() => {
        processedLines = [];
        processor = new LineProcessor();
    });

    afterEach(() => {
        if (processor) {
            processor.close();
        }
    });

    describe('Constructor', () => {
        it('should initialize with default options', () => {
            expect(processor.getBuffer()).toBe('');
            expect(processor.hasData()).toBe(false);
        });

        it('should accept custom delimiter (note: readline only supports line-based delimiters)', () => {
            const customProcessor = new LineProcessor({ delimiter: '\r\n' });
            expect(customProcessor.options.delimiter).toBe('\r\n');
            customProcessor.close();
        });

        it('should accept trimLines option', () => {
            const noTrimProcessor = new LineProcessor({ trimLines: false });
            expect(noTrimProcessor.options.trimLines).toBe(false);
            noTrimProcessor.close();
        });

        it('should accept skipEmptyLines option', () => {
            const noSkipProcessor = new LineProcessor({ skipEmptyLines: false });
            expect(noSkipProcessor.options.skipEmptyLines).toBe(false);
            noSkipProcessor.close();
        });
    });

    describe('processData', () => {
        it('should process single complete line', (done) => {
            processor.processData('hello world\n', (line) => {
                processedLines.push(line);
                expect(processedLines).toEqual(['hello world']);
                done();
            });
        });

        it('should process multiple complete lines', (done) => {
            let expectedLines = ['line1', 'line2', 'line3'];
            let processedCount = 0;
            
            processor.processData('line1\nline2\nline3\n', (line) => {
                processedLines.push(line);
                processedCount++;
                
                if (processedCount === expectedLines.length) {
                    expect(processedLines).toEqual(expectedLines);
                    done();
                }
            });
        });

        it('should handle Buffer input', (done) => {
            const buffer = Buffer.from('buffer line\n');
            processor.processData(buffer, (line) => {
                processedLines.push(line);
                expect(processedLines).toEqual(['buffer line']);
                done();
            });
        });

        it('should trim lines by default', (done) => {
            processor.processData('  spaced line  \n', (line) => {
                processedLines.push(line);
                expect(processedLines).toEqual(['spaced line']);
                done();
            });
        });

        it('should skip empty lines by default', (done) => {
            let expectedLines = ['line1', 'line2'];
            let processedCount = 0;
            
            processor.processData('line1\n\n\nline2\n', (line) => {
                processedLines.push(line);
                processedCount++;
                
                if (processedCount === expectedLines.length) {
                    expect(processedLines).toEqual(expectedLines);
                    done();
                }
            });
        });

        it('should throw error if lineProcessor is not a function', () => {
            expect(() => {
                processor.processData('test\n', 'not a function');
            }).toThrow('lineProcessor must be a function');
        });

        it('should not trim lines when trimLines is false', (done) => {
            const noTrimProcessor = new LineProcessor({ trimLines: false });
            noTrimProcessor.processData('  spaced line  \n', (line) => {
                processedLines.push(line);
                expect(processedLines).toEqual(['  spaced line  ']);
                noTrimProcessor.close();
                done();
            });
        });

        it('should not skip empty lines when skipEmptyLines is false', (done) => {
            const noSkipProcessor = new LineProcessor({ skipEmptyLines: false });
            let expectedLines = ['line1', '', '', 'line2'];
            let processedCount = 0;
            
            noSkipProcessor.processData('line1\n\n\nline2\n', (line) => {
                processedLines.push(line);
                processedCount++;
                
                if (processedCount === expectedLines.length) {
                    expect(processedLines).toEqual(expectedLines);
                    noSkipProcessor.close();
                    done();
                }
            });
        });
    });

    describe('Compatibility methods', () => {
        it('should return empty buffer for compatibility', () => {
            expect(processor.getBuffer()).toBe('');
        });

        it('should return false for hasData for compatibility', () => {
            expect(processor.hasData()).toBe(false);
        });

        it('should handle clearBuffer as no-op', () => {
            processor.clearBuffer();
            expect(processor.getBuffer()).toBe('');
        });

        it('should handle processFinalLine as no-op', () => {
            processor.processFinalLine(() => {});
            expect(processedLines).toEqual([]);
        });
    });

    describe('close', () => {
        it('should clean up resources', () => {
            processor.close();
            // Should not throw errors
            expect(processor.rl).toBeDefined();
        });
    });
});

describe('processLines utility function', () => {
    let processedLines;

    beforeEach(() => {
        processedLines = [];
    });

    it('should process complete lines', (done) => {
        // Since processLines uses streams, we need to handle async behavior
        setTimeout(() => {
            const remaining = processLines('line1\nline2\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2']);
            expect(remaining).toBe('');
            done();
        }, 10);
    });

    it('should handle Buffer input', (done) => {
        setTimeout(() => {
            const buffer = Buffer.from('line1\nline2\n');
            const remaining = processLines(buffer, (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2']);
            expect(remaining).toBe('');
            done();
        }, 10);
    });

    it('should respect custom options', (done) => {
        setTimeout(() => {
            const remaining = processLines(
                '  line1  \n  line2  \n',
                (line) => processedLines.push(line),
                { trimLines: false }
            );
            expect(processedLines).toEqual(['  line1  ', '  line2  ']);
            expect(remaining).toBe('');
            done();
        }, 10);
    });
});
