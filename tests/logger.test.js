const { Logger, createLogger, logger, error, warn, info, debug } = require('../src/logger');

describe('Logger', () => {
    let testLogger;
    let consoleLogSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleDebugSpy;

    beforeEach(() => {
        testLogger = new Logger({ component: 'test', level: 'debug', enabled: true });
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Constructor', () => {
        it('should initialize with default options', () => {
            const defaultLogger = new Logger();
            expect(defaultLogger.level).toBe('warn'); // Default in test environment
            expect(defaultLogger.component).toBe('cgateweb');
            expect(defaultLogger.enabled).toBe(true);
        });

        it('should initialize with custom options', () => {
            const customLogger = new Logger({
                level: 'warn',
                component: 'custom',
                enabled: false
            });
            expect(customLogger.level).toBe('warn');
            expect(customLogger.component).toBe('custom');
            expect(customLogger.enabled).toBe(false);
        });

        it('should default to info level for invalid level', () => {
            const invalidLogger = new Logger({ level: 'invalid' });
            expect(invalidLogger.currentLevel).toBe(2); // info level
        });
    });

    describe('Log level filtering', () => {
        it('should log messages at or above current level', () => {
            const infoLogger = new Logger({ level: 'info' });
            
            infoLogger.debug('debug message');
            expect(consoleDebugSpy).not.toHaveBeenCalled();
            
            infoLogger.info('info message');
            expect(consoleLogSpy).toHaveBeenCalled();
            
            infoLogger.warn('warn message');
            expect(consoleWarnSpy).toHaveBeenCalled();
            
            infoLogger.error('error message');
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should not log when disabled', () => {
            const disabledLogger = new Logger({ enabled: false });
            
            disabledLogger.error('error message');
            disabledLogger.warn('warn message');
            disabledLogger.info('info message');
            disabledLogger.debug('debug message');
            
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(consoleWarnSpy).not.toHaveBeenCalled();
            expect(consoleLogSpy).not.toHaveBeenCalled();
            expect(consoleDebugSpy).not.toHaveBeenCalled();
        });
    });

    describe('Message formatting', () => {
        it('should format messages with timestamp and component', () => {
            testLogger.info('test message');
            
            const call = consoleLogSpy.mock.calls[0][0];
            expect(call).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[test\] test message/);
        });

        it('should format messages without component when not provided', () => {
            const noComponentLogger = new Logger({ component: '', level: 'info' });
            noComponentLogger.info('test message');
            
            const call = consoleLogSpy.mock.calls[0][0];
            // When component is empty string, it still shows default component 'cgateweb'
            expect(call).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[cgateweb\] test message/);
        });

        it('should include metadata when provided', () => {
            testLogger.info('test message', { key: 'value', number: 42 });
            
            const call = consoleLogSpy.mock.calls[0][0];
            // In development mode, metadata is pretty-printed on multiple lines
            expect(call).toContain('"key": "value"');
            expect(call).toContain('"number": 42');
        });

        it('should handle empty metadata', () => {
            testLogger.info('test message', {});
            
            const call = consoleLogSpy.mock.calls[0][0];
            expect(call).not.toContain('{}');
        });
    });

    describe('Console method selection', () => {
        it('should use console.error for error level', () => {
            testLogger.error('error message');
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should use console.warn for warn level', () => {
            testLogger.warn('warn message');
            expect(consoleWarnSpy).toHaveBeenCalled();
        });

        it('should use console.debug for debug level', () => {
            testLogger.debug('debug message');
            expect(consoleDebugSpy).toHaveBeenCalled();
        });

        it('should use console.log for info and unknown levels', () => {
            testLogger.info('info message');
            expect(consoleLogSpy).toHaveBeenCalled();
        });
    });

    describe('Child logger', () => {
        it('should create child logger with inherited properties', () => {
            const childLogger = testLogger.child({ component: 'child' });
            
            expect(childLogger.level).toBe(testLogger.level);
            expect(childLogger.enabled).toBe(testLogger.enabled);
            expect(childLogger.component).toBe('child');
        });

        it('should allow overriding properties in child logger', () => {
            const childLogger = testLogger.child({
                component: 'child',
                level: 'error',
                enabled: false
            });
            
            expect(childLogger.level).toBe('error');
            expect(childLogger.enabled).toBe(false);
            expect(childLogger.component).toBe('child');
        });
    });

    describe('Dynamic level setting', () => {
        it('should update level dynamically', () => {
            testLogger.setLevel('error');
            expect(testLogger.level).toBe('error');
            expect(testLogger.currentLevel).toBe(0);

            testLogger.info('info message');
            expect(consoleLogSpy).not.toHaveBeenCalled();

            testLogger.error('error message');
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should ignore invalid level in setLevel', () => {
            const originalLevel = testLogger.level;
            const originalCurrentLevel = testLogger.currentLevel;

            testLogger.setLevel('invalid');

            expect(testLogger.level).toBe(originalLevel);
            expect(testLogger.currentLevel).toBe(originalCurrentLevel);
        });
    });

    describe('trace level', () => {
        it('should use console.debug for trace level', () => {
            const traceLogger = new Logger({ component: 'test', level: 'trace', enabled: true });
            traceLogger.trace('trace message');
            expect(consoleDebugSpy).toHaveBeenCalled();
        });

        it('should not log trace when level is above trace', () => {
            const infoLogger = new Logger({ component: 'test', level: 'info', enabled: true });
            infoLogger.trace('trace message');
            expect(consoleDebugSpy).not.toHaveBeenCalled();
        });
    });

    describe('time and timeEnd', () => {
        let consoleTimeSpy;
        let consoleTimeEndSpy;

        beforeEach(() => {
            consoleTimeSpy = jest.spyOn(console, 'time').mockImplementation();
            consoleTimeEndSpy = jest.spyOn(console, 'timeEnd').mockImplementation();
        });

        it.each([
            [true,  true],
            [false, false],
        ])('isDevelopment=%s: time/timeEnd %s call console helpers', (isDev, shouldCall) => {
            const logger = new Logger({ component: 'test' });
            logger.isDevelopment = isDev;
            logger.time('myTimer');
            logger.timeEnd('myTimer');
            if (shouldCall) {
                expect(consoleTimeSpy).toHaveBeenCalledWith('[test] myTimer');
                expect(consoleTimeEndSpy).toHaveBeenCalledWith('[test] myTimer');
            } else {
                expect(consoleTimeSpy).not.toHaveBeenCalled();
                expect(consoleTimeEndSpy).not.toHaveBeenCalled();
            }
        });
    });

    describe('_determineLogLevel', () => {
        const originalEnv = process.env;

        afterEach(() => {
            process.env = originalEnv;
        });

        it('should use LOG_LEVEL environment variable when set to a valid level', () => {
            process.env = { ...originalEnv, LOG_LEVEL: 'error', NODE_ENV: 'production' };
            const envLogger = new Logger();
            expect(envLogger.level).toBe('error');
        });

        it('should ignore LOG_LEVEL environment variable when set to an invalid level', () => {
            process.env = { ...originalEnv, LOG_LEVEL: 'invalid', NODE_ENV: 'production' };
            const envLogger = new Logger();
            expect(envLogger.level).toBe('info');
        });

        it('should default to info when NODE_ENV is not development or test', () => {
            process.env = { ...originalEnv, NODE_ENV: 'production', LOG_LEVEL: undefined };
            delete process.env.LOG_LEVEL;
            const prodLogger = new Logger();
            expect(prodLogger.level).toBe('info');
        });
    });

    describe('Color formatting', () => {
        it('should apply color codes when enableColors is true', () => {
            const colorLogger = new Logger({ component: 'test', level: 'debug', enabled: true });
            colorLogger.enableColors = true;
            colorLogger.enableVerbose = true;

            colorLogger.error('colored error');
            const errorCall = consoleErrorSpy.mock.calls[0][0];
            expect(errorCall).toContain('\x1b[31m'); // Red for ERROR

            colorLogger.warn('colored warn');
            const warnCall = consoleWarnSpy.mock.calls[0][0];
            expect(warnCall).toContain('\x1b[33m'); // Yellow for WARN

            colorLogger.info('colored info');
            const infoCall = consoleLogSpy.mock.calls[0][0];
            expect(infoCall).toContain('\x1b[36m'); // Cyan for INFO

            colorLogger.debug('colored debug');
            const debugCall = consoleDebugSpy.mock.calls[0][0];
            expect(debugCall).toContain('\x1b[90m'); // Gray for DEBUG
        });

        it('should apply reset code after color when enableColors is true', () => {
            const colorLogger = new Logger({ component: 'test', level: 'info', enabled: true });
            colorLogger.enableColors = true;
            colorLogger.enableVerbose = false;

            colorLogger.info('colored info');
            const call = consoleLogSpy.mock.calls[0][0];
            expect(call).toContain('\x1b[0m'); // Reset code
        });
    });

    describe('Compact metadata formatting', () => {
        it('should use compact JSON format when enableVerbose is false', () => {
            const prodLogger = new Logger({ component: 'test', level: 'info', enabled: true });
            prodLogger.enableVerbose = false;

            prodLogger.info('test message', { key: 'value' });
            const call = consoleLogSpy.mock.calls[0][0];
            // Compact format: single line JSON appended with a space
            expect(call).toContain('{"key":"value"}');
        });
    });
});

describe('Module exports', () => {
    let consoleLogSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleDebugSpy;

    beforeEach(() => {
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('createLogger function', () => {
        it('should create logger with options', () => {
            const customLogger = createLogger({ component: 'custom', level: 'warn' });
            expect(customLogger).toBeInstanceOf(Logger);
            expect(customLogger.component).toBe('custom');
            expect(customLogger.level).toBe('warn');
        });
    });

    describe('Default logger instance', () => {
        it('should provide default logger instance', () => {
            expect(logger).toBeInstanceOf(Logger);
        });
    });

    describe('Convenience functions', () => {
        it('should provide error convenience function', () => {
            error('test error');
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should provide warn convenience function', () => {
            warn('test warning');
            expect(consoleWarnSpy).toHaveBeenCalled();
        });

        it('should provide info convenience function', () => {
            // Need to set logger to info level since default is warn in test environment
            const originalLevel = logger.level;
            logger.setLevel('info');
            
            info('test info');
            expect(consoleLogSpy).toHaveBeenCalled();
            
            // Restore original level
            logger.setLevel(originalLevel);
        });

        it('should provide debug convenience function', () => {
            // Default logger level is 'info', so debug messages won't be logged
            // We need to set the logger to debug level first
            const originalLevel = logger.level;
            logger.setLevel('debug');
            
            debug('test debug');
            expect(consoleDebugSpy).toHaveBeenCalled();
            
            // Restore original level
            logger.setLevel(originalLevel);
        });

        it('should pass metadata to convenience functions', () => {
            // Need to set logger to info level since default is warn in test environment
            const originalLevel = logger.level;
            logger.setLevel('info');
            
            const metadata = { key: 'value' };
            info('test message', metadata);
            
            const call = consoleLogSpy.mock.calls[0][0];
            expect(call).toContain('"key": "value"');
            
            // Restore original level
            logger.setLevel(originalLevel);
        });
    });
});