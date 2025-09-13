const fs = require('fs');
const path = require('path');
const EnvironmentDetector = require('../../src/config/EnvironmentDetector');

// Mock filesystem operations
jest.mock('fs');

describe('EnvironmentDetector', () => {
    let detector;
    let originalEnv;

    beforeEach(() => {
        detector = new EnvironmentDetector();
        
        // Save original environment
        originalEnv = { ...process.env };
        
        // Reset mocks
        jest.clearAllMocks();
        
        // Reset detector state
        detector.reset();
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
    });

    describe('detect() - Home Assistant Addon Environment', () => {
        test('should detect addon environment with options file and data directory', () => {
            // Mock Home Assistant addon environment
            fs.existsSync.mockImplementation((filePath) => {
                if (filePath === '/data/options.json') return true;
                if (filePath === '/data') return true;
                if (filePath === '/config') return true;
                return false;
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath === '/data/options.json',
                isDirectory: () => filePath === '/data' || filePath === '/config'
            }));

            const result = detector.detect();

            expect(result.type).toBe('addon');
            expect(result.isAddon).toBe(true);
            expect(result.isStandalone).toBe(false);
            expect(result.optionsPath).toBe('/data/options.json');
            expect(result.dataPath).toBe('/data');
            expect(result.configPath).toBe('/config');
            expect(result.indicators.hasOptionsFile).toBe(true);
            expect(result.indicators.hasDataDirectory).toBe(true);
        });

        test('should detect addon environment with supervisor token', () => {
            process.env.SUPERVISOR_TOKEN = 'test-token';

            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));

            const result = detector.detect();

            expect(result.type).toBe('addon');
            expect(result.isAddon).toBe(true);
            expect(result.supervisorToken).toBe('test-token');
            expect(result.indicators.hasSupervisorToken).toBe(true);
        });

        test('should detect addon environment with ingress session', () => {
            process.env.INGRESS_SESSION = 'test-session';

            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));

            const result = detector.detect();

            expect(result.type).toBe('addon');
            expect(result.isAddon).toBe(true);
            expect(result.indicators.hasIngress).toBe(true);
        });

        test('should cache detection result on subsequent calls', () => {
            fs.existsSync.mockImplementation((filePath) => {
                return filePath === '/data/options.json' || filePath === '/data';
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath === '/data/options.json',
                isDirectory: () => filePath === '/data'
            }));

            const result1 = detector.detect();
            const result2 = detector.detect();

            expect(result1).toBe(result2); // Should be the same object reference
            expect(fs.existsSync).toHaveBeenCalledTimes(3); // Only called once for detection
        });
    });

    describe('detect() - Standalone Environment', () => {
        test('should detect standalone environment when no addon indicators present', () => {
            fs.existsSync.mockImplementation((filePath) => {
                // Mock settings.js exists at current directory
                if (filePath.endsWith('settings.js')) return true;
                return false;
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath.includes('settings.js'),
                isDirectory: () => false
            }));

            const result = detector.detect();

            expect(result.type).toBe('standalone');
            expect(result.isStandalone).toBe(true);
            expect(result.isAddon).toBe(false);
            expect(result.settingsPath).toBeDefined();
            expect(result.workingDirectory).toBe(process.cwd());
            expect(result.indicators.hasSettingsFile).toBe(true);
        });

        test('should detect Docker environment in standalone mode', () => {
            fs.existsSync.mockImplementation((filePath) => {
                if (filePath === '/.dockerenv') return true;
                if (filePath.includes('settings.js')) return true;
                return false;
            });

            fs.statSync.mockImplementation(() => ({ isFile: () => true, isDirectory: () => false }));

            const result = detector.detect();

            expect(result.type).toBe('standalone');
            expect(result.indicators.runningInDocker).toBe(true);
        });

        test('should handle missing settings.js file gracefully', () => {
            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));

            const result = detector.detect();

            expect(result.type).toBe('standalone');
            expect(result.indicators.hasSettingsFile).toBe(false);
            expect(result.settingsPath).toBeDefined(); // Should still have a fallback path
        });
    });

    describe('environment type methods', () => {
        test('getEnvironmentType() should return correct type', () => {
            fs.existsSync.mockImplementation((filePath) => {
                return filePath === '/data/options.json' || filePath === '/data';
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath === '/data/options.json',
                isDirectory: () => filePath === '/data'
            }));

            expect(detector.getEnvironmentType()).toBe('addon');
        });

        test('isAddon() should return true for addon environment', () => {
            fs.existsSync.mockImplementation((filePath) => {
                return filePath === '/data/options.json' || filePath === '/data';
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath === '/data/options.json',
                isDirectory: () => filePath === '/data'
            }));

            expect(detector.isAddon()).toBe(true);
            expect(detector.isStandalone()).toBe(false);
        });

        test('isStandalone() should return true for standalone environment', () => {
            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));

            expect(detector.isStandalone()).toBe(true);
            expect(detector.isAddon()).toBe(false);
        });
    });

    describe('_findSettingsFile()', () => {
        test('should find settings.js in current directory', () => {
            fs.existsSync.mockImplementation((filePath) => {
                return filePath.includes(path.join(process.cwd(), 'settings.js'));
            });

            fs.statSync.mockImplementation(() => ({ isFile: () => true, isDirectory: () => false }));

            const result = detector.detect();
            expect(result.settingsPath).toBe(path.resolve(path.join(process.cwd(), 'settings.js')));
        });

        test('should search multiple locations for settings.js', () => {
            const mockCalls = [];
            fs.existsSync.mockImplementation((filePath) => {
                mockCalls.push(filePath);
                // Return true for the second possible path
                return filePath.includes(path.join(__dirname, '../../settings.js'));
            });

            fs.statSync.mockImplementation(() => ({ isFile: () => true, isDirectory: () => false }));

            detector.detect();

            // Should have tried multiple paths
            expect(mockCalls.length).toBeGreaterThan(1);
        });
    });

    describe('error handling', () => {
        test('should handle filesystem errors gracefully', () => {
            fs.existsSync.mockImplementation(() => {
                throw new Error('Filesystem error');
            });

            fs.statSync.mockImplementation(() => {
                throw new Error('Filesystem error');
            });

            // Should not throw, should fallback to standalone
            expect(() => detector.detect()).not.toThrow();
            expect(detector.getEnvironmentType()).toBe('standalone');
        });

        test('should handle Docker detection errors gracefully', () => {
            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));
            fs.readFileSync.mockImplementation(() => {
                throw new Error('Cannot read cgroup file');
            });

            const result = detector.detect();
            
            expect(result.type).toBe('standalone');
            expect(result.indicators.runningInDocker).toBe(false);
        });
    });

    describe('reset functionality', () => {
        test('should reset detection state', () => {
            fs.existsSync.mockImplementation((filePath) => {
                return filePath === '/data/options.json' || filePath === '/data';
            });

            fs.statSync.mockImplementation((filePath) => ({
                isFile: () => filePath === '/data/options.json',
                isDirectory: () => filePath === '/data'
            }));

            // First detection
            const result1 = detector.detect();
            expect(result1.type).toBe('addon');

            // Reset and change mock behavior
            detector.reset();
            fs.existsSync.mockReturnValue(false);
            fs.statSync.mockImplementation(() => ({ isFile: () => false, isDirectory: () => false }));

            // Second detection should use new mock behavior
            const result2 = detector.detect();
            expect(result2.type).toBe('standalone');
        });
    });
});
