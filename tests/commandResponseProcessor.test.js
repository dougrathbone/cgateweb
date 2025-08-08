const CommandResponseProcessor = require('../src/commandResponseProcessor');
const CBusEvent = require('../src/cbusEvent');
const {
    CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_TREE_END
} = require('../src/constants');

describe('CommandResponseProcessor', () => {
    let processor;
    let mockEventPublisher;
    let mockHaDiscovery;
    let mockOnObjectStatus;
    let mockLogger;

    beforeEach(() => {
        mockEventPublisher = {
            publishEvent: jest.fn()
        };

        mockHaDiscovery = {
            handleTreeStart: jest.fn(),
            handleTreeData: jest.fn(),
            handleTreeEnd: jest.fn()
        };

        mockOnObjectStatus = jest.fn();

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        processor = new CommandResponseProcessor({
            eventPublisher: mockEventPublisher,
            haDiscovery: mockHaDiscovery,
            onObjectStatus: mockOnObjectStatus,
            logger: mockLogger
        });
    });

    describe('constructor', () => {
        it('should initialize with required dependencies', () => {
            expect(processor.eventPublisher).toBe(mockEventPublisher);
            expect(processor.haDiscovery).toBe(mockHaDiscovery);
            expect(processor.onObjectStatus).toBe(mockOnObjectStatus);
            expect(processor.logger).toBe(mockLogger);
        });

        it('should create default logger if none provided', () => {
            const processorWithoutLogger = new CommandResponseProcessor({
                eventPublisher: mockEventPublisher,
                haDiscovery: mockHaDiscovery,
                onObjectStatus: mockOnObjectStatus
            });
            
            expect(processorWithoutLogger.logger).toBeDefined();
            expect(typeof processorWithoutLogger.logger.info).toBe('function');
        });
    });

    describe('processLine', () => {
        it('should log received line', () => {
            processor.processLine('200-OK');
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('C-Gate Recv (Cmd): 200-OK'));
        });

        it('should parse and process valid response lines', () => {
            const parseSpy = jest.spyOn(processor, '_parseCommandResponseLine');
            const processSpy = jest.spyOn(processor, '_processCommandResponse');
            
            parseSpy.mockReturnValue({ responseCode: '200', statusData: 'OK' });
            
            processor.processLine('200-OK');
            
            expect(parseSpy).toHaveBeenCalledWith('200-OK');
            expect(processSpy).toHaveBeenCalledWith('200', 'OK');
        });

        it('should handle parsing errors gracefully', () => {
            const parseSpy = jest.spyOn(processor, '_parseCommandResponseLine');
            parseSpy.mockImplementation(() => { throw new Error('Parse error'); });
            
            processor.processLine('invalid-line');
            
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Error processing command data line:'),
                expect.any(Error),
                'Line: invalid-line'
            );
        });

        it('should skip processing if parsing returns null', () => {
            const parseSpy = jest.spyOn(processor, '_parseCommandResponseLine');
            const processSpy = jest.spyOn(processor, '_processCommandResponse');
            
            parseSpy.mockReturnValue(null);
            
            processor.processLine('invalid-line');
            
            expect(processSpy).not.toHaveBeenCalled();
        });
    });

    describe('_parseCommandResponseLine', () => {
        it('should parse hyphen-separated response lines', () => {
            const result = processor._parseCommandResponseLine('200-OK');
            expect(result).toEqual({ responseCode: '200', statusData: 'OK' });
        });

        it('should parse object status lines with hyphens', () => {
            const line = '300-//SHAC/254/56/1: level=255';
            const result = processor._parseCommandResponseLine(line);
            expect(result).toEqual({ 
                responseCode: '300', 
                statusData: '//SHAC/254/56/1: level=255' 
            });
        });

        it('should parse space-separated response lines', () => {
            const result = processor._parseCommandResponseLine('200 OK');
            expect(result).toEqual({ responseCode: '200', statusData: 'OK' });
        });

        it('should handle multi-word status data with spaces', () => {
            const result = processor._parseCommandResponseLine('404 Object not found');
            expect(result).toEqual({ responseCode: '404', statusData: 'Object not found' });
        });

        it('should return null for invalid response codes', () => {
            expect(processor._parseCommandResponseLine('ABC-Invalid')).toBeNull();
            expect(processor._parseCommandResponseLine('99-TooShort')).toBeNull();
            expect(processor._parseCommandResponseLine('7000-TooLong')).toBeNull();
            expect(processor._parseCommandResponseLine('')).toBeNull();
        });

        it('should handle lines with only response code', () => {
            const result = processor._parseCommandResponseLine('200');
            expect(result).toEqual({ responseCode: '200', statusData: '' });
        });

        it('should trim whitespace from response parts', () => {
            const result = processor._parseCommandResponseLine('  200  -  OK  ');
            expect(result).toEqual({ responseCode: '200', statusData: 'OK' });
        });

        it('should log skipped invalid lines', () => {
            processor._parseCommandResponseLine('invalid-line');
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Skipping invalid command response line: invalid-line')
            );
        });
    });

    describe('_processCommandResponse', () => {
        it('should route object status responses', () => {
            const processSpy = jest.spyOn(processor, '_processCommandObjectStatus');
            
            processor._processCommandResponse(CGATE_RESPONSE_OBJECT_STATUS, 'status data');
            
            expect(processSpy).toHaveBeenCalledWith('status data');
        });

        it('should route tree start responses to HA discovery', () => {
            processor._processCommandResponse(CGATE_RESPONSE_TREE_START, 'tree start data');
            
            expect(mockHaDiscovery.handleTreeStart).toHaveBeenCalledWith('tree start data');
        });

        it('should route tree data responses to HA discovery', () => {
            processor._processCommandResponse(CGATE_RESPONSE_TREE_DATA, 'tree data');
            
            expect(mockHaDiscovery.handleTreeData).toHaveBeenCalledWith('tree data');
        });

        it('should route tree end responses to HA discovery', () => {
            processor._processCommandResponse(CGATE_RESPONSE_TREE_END, 'tree end data');
            
            expect(mockHaDiscovery.handleTreeEnd).toHaveBeenCalledWith('tree end data');
        });

        it('should route 4xx error responses', () => {
            const errorSpy = jest.spyOn(processor, '_processCommandErrorResponse');
            
            processor._processCommandResponse('404', 'Not found');
            
            expect(errorSpy).toHaveBeenCalledWith('404', 'Not found');
        });

        it('should route 5xx error responses', () => {
            const errorSpy = jest.spyOn(processor, '_processCommandErrorResponse');
            
            processor._processCommandResponse('500', 'Internal error');
            
            expect(errorSpy).toHaveBeenCalledWith('500', 'Internal error');
        });

        it('should log unhandled response codes', () => {
            processor._processCommandResponse('100', 'Info response');
            
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Unhandled C-Gate response 100: Info response')
            );
        });
    });

    describe('_processCommandObjectStatus', () => {
        it('should process valid object status events', () => {
            const statusData = '//SHAC/254/56/1: level=255';
            
            processor._processCommandObjectStatus(statusData);
            
            expect(mockEventPublisher.publishEvent).toHaveBeenCalledWith(
                expect.any(CBusEvent),
                '(Cmd)'
            );
            expect(mockOnObjectStatus).toHaveBeenCalledWith(expect.any(CBusEvent));
        });

        it('should warn about invalid object status data', () => {
            const statusData = 'invalid status data';
            
            processor._processCommandObjectStatus(statusData);
            
            expect(mockEventPublisher.publishEvent).not.toHaveBeenCalled();
            expect(mockOnObjectStatus).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Could not parse object status: invalid status data')
            );
        });

        it('should handle missing onObjectStatus callback gracefully', () => {
            const processorWithoutCallback = new CommandResponseProcessor({
                eventPublisher: mockEventPublisher,
                haDiscovery: mockHaDiscovery,
                onObjectStatus: null,
                logger: mockLogger
            });
            
            const statusData = '//SHAC/254/56/1: level=255';
            
            expect(() => {
                processorWithoutCallback._processCommandObjectStatus(statusData);
            }).not.toThrow();
            
            expect(mockEventPublisher.publishEvent).toHaveBeenCalled();
        });
    });

    describe('_processCommandErrorResponse', () => {
        it('should log error with appropriate hint for known error codes', () => {
            const testCases = [
                { code: '400', hint: '(Bad Request/Syntax Error)' },
                { code: '401', hint: '(Unauthorized - Check Credentials/Permissions)' },
                { code: '404', hint: '(Not Found - Check Object Path)' },
                { code: '406', hint: '(Not Acceptable - Invalid Parameter Value)' },
                { code: '500', hint: '(Internal Server Error)' },
                { code: '503', hint: '(Service Unavailable)' }
            ];

            testCases.forEach(({ code, hint }) => {
                processor._processCommandErrorResponse(code, 'Error details');
                
                expect(mockLogger.error).toHaveBeenCalledWith(
                    expect.stringContaining(`C-Gate Command Error ${code}: ${hint} - Error details`)
                );
            });
        });

        it('should log error without hint for unknown error codes', () => {
            processor._processCommandErrorResponse('499', 'Unknown error');
            
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('C-Gate Command Error 499: - Unknown error')
            );
        });

        it('should handle empty status data', () => {
            processor._processCommandErrorResponse('404', '');
            
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('No details provided')
            );
        });

        it('should handle null status data', () => {
            processor._processCommandErrorResponse('404', null);
            
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('No details provided')
            );
        });
    });
});
