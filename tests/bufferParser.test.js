const { BufferParser, processLines } = require('../src/bufferParser');

describe('BufferParser', () => {
    let parser;
    let processedLines;

    beforeEach(() => {
        processedLines = [];
        parser = new BufferParser();
    });

    describe('Constructor', () => {
        it('should initialize with default options', () => {
            expect(parser.getBuffer()).toBe('');
            expect(parser.hasData()).toBe(false);
        });

        it('should accept custom delimiter', () => {
            const customParser = new BufferParser({ delimiter: '|' });
            customParser.processData('line1|line2', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1']);
            expect(customParser.getBuffer()).toBe('line2');
        });

        it('should accept trimLines option', () => {
            const noTrimParser = new BufferParser({ trimLines: false });
            noTrimParser.processData('  line1  \n  line2  ', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['  line1  ']);
            expect(noTrimParser.getBuffer()).toBe('  line2  ');
        });

        it('should accept skipEmptyLines option', () => {
            const noSkipParser = new BufferParser({ skipEmptyLines: false });
            noSkipParser.processData('line1\n\nline2', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', '']);
            expect(noSkipParser.getBuffer()).toBe('line2');
        });
    });

    describe('processData', () => {
        it('should process single complete line', () => {
            parser.processData('hello world\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['hello world']);
            expect(parser.getBuffer()).toBe('');
        });

        it('should process multiple complete lines', () => {
            parser.processData('line1\nline2\nline3\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2', 'line3']);
            expect(parser.getBuffer()).toBe('');
        });

        it('should handle incomplete lines', () => {
            parser.processData('partial', (line) => processedLines.push(line));
            expect(processedLines).toEqual([]);
            expect(parser.getBuffer()).toBe('partial');
        });

        it('should combine incomplete and complete lines', () => {
            parser.processData('partial', (line) => processedLines.push(line));
            parser.processData(' line\ncomplete line\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['partial line', 'complete line']);
            expect(parser.getBuffer()).toBe('');
        });

        it('should handle Buffer input', () => {
            const buffer = Buffer.from('buffer line\n');
            parser.processData(buffer, (line) => processedLines.push(line));
            expect(processedLines).toEqual(['buffer line']);
        });

        it('should trim lines by default', () => {
            parser.processData('  spaced line  \n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['spaced line']);
        });

        it('should skip empty lines by default', () => {
            parser.processData('line1\n\n\nline2\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2']);
        });

        it('should throw error if lineProcessor is not a function', () => {
            expect(() => {
                parser.processData('test\n', 'not a function');
            }).toThrow('lineProcessor must be a function');
        });

        it('should re-throw errors from lineProcessor with context', () => {
            const errorProcessor = (_line) => {
                throw new Error('Processing failed');
            };
            
            expect(() => {
                parser.processData('error line\n', errorProcessor);
            }).toThrow('Error processing line "error line": Processing failed');
        });

        it('should handle multiple newlines in sequence', () => {
            parser.processData('line1\n\n\n\nline2\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2']);
        });

        it('should handle mixed line endings', () => {
            const customParser = new BufferParser({ delimiter: '\r\n' });
            customParser.processData('line1\r\nline2\r\n', (line) => processedLines.push(line));
            expect(processedLines).toEqual(['line1', 'line2']);
        });
    });

    describe('Buffer management methods', () => {
        it('should report buffer status correctly', () => {
            expect(parser.hasData()).toBe(false);
            parser.processData('incomplete', () => {});
            expect(parser.hasData()).toBe(true);
            expect(parser.getBuffer()).toBe('incomplete');
        });

        it('should clear buffer', () => {
            parser.processData('test data', () => {});
            expect(parser.hasData()).toBe(true);
            parser.clearBuffer();
            expect(parser.hasData()).toBe(false);
            expect(parser.getBuffer()).toBe('');
        });

        it('should process final line', () => {
            parser.processData('final line without newline', () => {});
            parser.processFinalLine((line) => processedLines.push(line));
            expect(processedLines).toEqual(['final line without newline']);
            expect(parser.hasData()).toBe(false);
        });

        it('should handle empty buffer in processFinalLine', () => {
            parser.processFinalLine((line) => processedLines.push(line));
            expect(processedLines).toEqual([]);
        });

        it('should respect trimLines option in processFinalLine', () => {
            const noTrimParser = new BufferParser({ trimLines: false });
            noTrimParser.processData('  final  ', () => {});
            noTrimParser.processFinalLine((line) => processedLines.push(line));
            expect(processedLines).toEqual(['  final  ']);
        });

        it('should respect skipEmptyLines option in processFinalLine', () => {
            const noSkipParser = new BufferParser({ skipEmptyLines: false });
            noSkipParser.processData('   ', () => {});
            noSkipParser.processFinalLine((line) => processedLines.push(line));
            expect(processedLines).toEqual(['']);
        });
    });
});

describe('processLines utility function', () => {
    let processedLines;

    beforeEach(() => {
        processedLines = [];
    });

    it('should process complete lines and return remaining buffer', () => {
        const remaining = processLines('line1\nline2\npartial', (line) => processedLines.push(line));
        expect(processedLines).toEqual(['line1', 'line2']);
        expect(remaining).toBe('partial');
    });

    it('should process final line when requested', () => {
        const remaining = processLines(
            'line1\npartial', 
            (line) => processedLines.push(line),
            { processFinalLine: true }
        );
        expect(processedLines).toEqual(['line1', 'partial']);
        expect(remaining).toBe('');
    });

    it('should respect custom options', () => {
        const remaining = processLines(
            'line1|  line2  |',
            (line) => processedLines.push(line),
            { delimiter: '|', trimLines: false }
        );
        expect(processedLines).toEqual(['line1', '  line2  ']);
        expect(remaining).toBe('');
    });

    it('should handle Buffer input', () => {
        const buffer = Buffer.from('line1\nline2\n');
        const remaining = processLines(buffer, (line) => processedLines.push(line));
        expect(processedLines).toEqual(['line1', 'line2']);
        expect(remaining).toBe('');
    });

    it('should return empty string when no remaining data', () => {
        const remaining = processLines('complete\n', (line) => processedLines.push(line));
        expect(processedLines).toEqual(['complete']);
        expect(remaining).toBe('');
    });
});