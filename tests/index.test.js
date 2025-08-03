const path = require('path');

// Mock the CgateWebBridge before requiring index
jest.mock('../src/cgateWebBridge');
const MockCgateWebBridge = require('../src/cgateWebBridge');

// Mock settings validator
jest.mock('../src/settingsValidator');
const { validateWithWarnings } = require('../src/settingsValidator');

// Mock console methods
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();

// Mock process methods
const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation();

describe('index.js', () => {
    let originalRequireMain;
    let mockBridge;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Reset module cache to get fresh instance
        delete require.cache[require.resolve('../index.js')];
        
        // Mock CgateWebBridge instance
        mockBridge = {
            start: jest.fn().mockResolvedValue(), // Now async
            stop: jest.fn().mockResolvedValue()   // Now async
        };
        MockCgateWebBridge.mockImplementation(() => mockBridge);
        
        // Store original require.main
        originalRequireMain = require.main;
    });

    afterEach(() => {
        // Restore require.main
        require.main = originalRequireMain;
        mockConsoleLog.mockRestore();
        mockConsoleError.mockRestore();
        mockProcessExit.mockRestore();
    });

    describe('Module exports', () => {
        it('should export defaultSettings', () => {
            const indexModule = require('../index.js');
            expect(indexModule.defaultSettings).toBeDefined();
            expect(indexModule.defaultSettings.mqtt).toBe('localhost:1883');
            expect(indexModule.defaultSettings.cbusip).toBe('your-cgate-ip');
            expect(indexModule.defaultSettings.cbusname).toBe('CLIPSAL');
        });

        it('should export CgateWebBridge class', () => {
            const indexModule = require('../index.js');
            expect(indexModule.CgateWebBridge).toBeDefined();
        });
    });

    describe('Settings loading', () => {
        it('should handle missing settings.js file', () => {
            // Reset module cache to ensure fresh require
            delete require.cache[require.resolve('../index.js')];
            delete require.cache[require.resolve('../settings.js')];
            
            // Mock MODULE_NOT_FOUND error
            jest.doMock('../settings.js', () => {
                const error = new Error('Cannot find module');
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            });
            
            require('../index.js');
            
            expect(mockConsoleError).toHaveBeenCalledWith(
                '[ERROR] Configuration file ./settings.js not found. Using default settings.'
            );
            
            jest.dontMock('../settings.js');
        });

        it('should handle other settings.js loading errors', () => {
            // Reset module cache to ensure fresh require
            delete require.cache[require.resolve('../index.js')];
            delete require.cache[require.resolve('../settings.js')];
            
            // Mock generic error
            jest.doMock('../settings.js', () => {
                throw new Error('Syntax error in settings file');
            });
            
            require('../index.js');
            
            expect(mockConsoleError).toHaveBeenCalledWith(
                '[ERROR] Error loading ./settings.js: Syntax error in settings file. Using default settings.'
            );
            
            jest.dontMock('../settings.js');
        });

        it('should merge user settings with defaults when available', () => {
            // Mock valid settings file
            jest.doMock('../settings.js', () => ({
                mqtt: 'custom.broker:1883',
                logging: false,
                customProperty: 'test'
            }));
            
            // Temporarily set require.main to trigger main()
            require.main = { filename: require.resolve('../index.js') };
            
            require('../index.js');
            
            // Verify bridge was created with merged settings
            expect(MockCgateWebBridge).toHaveBeenCalledWith(
                expect.objectContaining({
                    mqtt: 'custom.broker:1883',
                    logging: false,
                    customProperty: 'test',
                    cbusip: 'your-cgate-ip' // Default should still be present
                })
            );
            
            jest.dontMock('../settings.js');
        });
    });

    describe('main() function execution', () => {
        beforeEach(() => {
            // Mock package.json
            jest.doMock('../package.json', () => ({ version: '1.0.0' }));
        });

        afterEach(() => {
            jest.dontMock('../package.json');
        });

        it('should start application when run as main module', () => {
            require.main = { filename: require.resolve('../index.js') };
            
            require('../index.js');
            
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Starting cgateweb...');
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Version: 1.0.0');
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] cgateweb started successfully');
            expect(validateWithWarnings).toHaveBeenCalled();
            expect(MockCgateWebBridge).toHaveBeenCalled();
            expect(mockBridge.start).toHaveBeenCalled();
        });

        it('should not start application when imported as module', () => {
            require.main = { filename: '/some/other/file.js' };
            
            require('../index.js');
            
            expect(mockConsoleLog).not.toHaveBeenCalledWith('[INFO] Starting cgateweb...');
            expect(MockCgateWebBridge).not.toHaveBeenCalled();
        });
    });

    describe('Signal handling', () => {
        let processOnSpy;

        beforeEach(() => {
            processOnSpy = jest.spyOn(process, 'on');
            require.main = { filename: require.resolve('../index.js') };
        });

        afterEach(() => {
            processOnSpy.mockRestore();
        });

        it('should set up signal handlers', () => {
            require('../index.js');
            
            expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('SIGUSR1', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
            expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
        });

        it('should handle SIGTERM gracefully', () => {
            require('../index.js');
            
            // Get the SIGTERM handler
            const sigtermHandler = processOnSpy.mock.calls.find(call => call[0] === 'SIGTERM')[1];
            
            sigtermHandler();
            
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Received SIGTERM, shutting down gracefully...');
            expect(mockBridge.stop).toHaveBeenCalled();
            expect(mockProcessExit).toHaveBeenCalledWith(0);
        });

        it('should handle SIGINT gracefully', () => {
            require('../index.js');
            
            // Get the SIGINT handler
            const sigintHandler = processOnSpy.mock.calls.find(call => call[0] === 'SIGINT')[1];
            
            sigintHandler();
            
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Received SIGINT, shutting down gracefully...');
            expect(mockBridge.stop).toHaveBeenCalled();
            expect(mockProcessExit).toHaveBeenCalledWith(0);
        });

        it('should handle SIGUSR1 for configuration reload', () => {
            require('../index.js');
            
            // Get the SIGUSR1 handler
            const sigusr1Handler = processOnSpy.mock.calls.find(call => call[0] === 'SIGUSR1')[1];
            
            sigusr1Handler();
            
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Received SIGUSR1, reloading configuration...');
        });

        it('should handle uncaught exceptions', () => {
            require('../index.js');
            
            // Get the uncaughtException handler
            const exceptionHandler = processOnSpy.mock.calls.find(call => call[0] === 'uncaughtException')[1];
            const testError = new Error('Test uncaught exception');
            
            exceptionHandler(testError);
            
            expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] Uncaught exception:', testError);
            expect(mockBridge.stop).toHaveBeenCalled();
            expect(mockProcessExit).toHaveBeenCalledWith(1);
        });

        it('should handle unhandled promise rejections', () => {
            require('../index.js');
            
            // Get the unhandledRejection handler
            const rejectionHandler = processOnSpy.mock.calls.find(call => call[0] === 'unhandledRejection')[1];
            const testReason = 'Test rejection reason';
            const testPromise = Promise.resolve();
            
            rejectionHandler(testReason, testPromise);
            
            expect(mockConsoleError).toHaveBeenCalledWith(
                '[ERROR] Unhandled promise rejection at:', testPromise, 'reason:', testReason
            );
            expect(mockBridge.stop).toHaveBeenCalled();
            expect(mockProcessExit).toHaveBeenCalledWith(1);
        });
    });
});