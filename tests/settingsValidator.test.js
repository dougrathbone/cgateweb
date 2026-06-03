const { SettingsValidator, validate, validateWithWarnings, createValidator } = require('../src/settingsValidator');

describe('SettingsValidator', () => {
    let validator;
    let validSettings;
    let originalConsole;

    beforeAll(() => {
        // Suppress console output during tests
        originalConsole = {
            error: console.error,
            warn: console.warn,
            log: console.log
        };
        console.error = jest.fn();
        console.warn = jest.fn();
        console.log = jest.fn();
    });

    afterAll(() => {
        // Restore console methods
        console.error = originalConsole.error;
        console.warn = originalConsole.warn;
        console.log = originalConsole.log;
    });

    beforeEach(() => {
        validator = new SettingsValidator({ exitOnError: false });
        validSettings = {
            mqtt: 'localhost:1883',
            cbusname: 'HOME',
            cbusip: '192.168.1.100',
            cbuscommandport: 20023,
            cbuseventport: 20025,
            messageinterval: 200,
            ha_discovery_enabled: false,
            ha_discovery_prefix: 'homeassistant',
            ha_discovery_networks: [254]
        };
    });

    describe('Constructor', () => {
        it('should initialize with default options', () => {
            const defaultValidator = new SettingsValidator();
            expect(defaultValidator.exitOnError).toBe(true);
        });

        it('should accept custom options', () => {
            const customValidator = new SettingsValidator({ exitOnError: false });
            expect(customValidator.exitOnError).toBe(false);
        });
    });

    describe('validate', () => {
        it('should return true for valid settings', () => {
            const result = validator.validate(validSettings);
            expect(result).toBe(true);
        });

        it('should return false for missing mqtt setting', () => {
            const invalidSettings = { ...validSettings };
            delete invalidSettings.mqtt;
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for empty mqtt setting', () => {
            const invalidSettings = { ...validSettings, mqtt: '' };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for null mqtt setting', () => {
            const invalidSettings = { ...validSettings, mqtt: null };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for missing cbusname setting', () => {
            const invalidSettings = { ...validSettings };
            delete invalidSettings.cbusname;
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for empty cbusname setting', () => {
            const invalidSettings = { ...validSettings, cbusname: '' };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for missing cbusip setting', () => {
            const invalidSettings = { ...validSettings };
            delete invalidSettings.cbusip;
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for non-string cbusip setting', () => {
            const invalidSettings = { ...validSettings, cbusip: 12345 };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for invalid cbuscommandport', () => {
            const invalidSettings = { ...validSettings, cbuscommandport: 'not-a-number' };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for negative cbuscommandport', () => {
            const invalidSettings = { ...validSettings, cbuscommandport: -1 };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for zero cbuscommandport', () => {
            const invalidSettings = { ...validSettings, cbuscommandport: 0 };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for invalid messageinterval', () => {
            const invalidSettings = { ...validSettings, messageinterval: 'invalid' };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false when command and event ports are the same', () => {
            const invalidSettings = { 
                ...validSettings, 
                cbuscommandport: 20023,
                cbuseventport: 20023
            };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for port out of valid range (too high)', () => {
            const invalidSettings = { ...validSettings, cbuscommandport: 70000 };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should return false for port out of valid range (too low)', () => {
            const invalidSettings = { ...validSettings, cbuseventport: 0 };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should validate MQTT format with mqtt:// prefix', () => {
            const settingsWithMqttPrefix = { ...validSettings, mqtt: 'mqtt://localhost:1883' };
            const result = validator.validate(settingsWithMqttPrefix);
            expect(result).toBe(true);
        });

        it('should return false for invalid MQTT format', () => {
            const invalidSettings = { ...validSettings, mqtt: 'invalid-mqtt-format' };
            const result = validator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should handle HA discovery validation when enabled', () => {
            const haSettings = { 
                ...validSettings, 
                ha_discovery_enabled: true,
                ha_discovery_prefix: '',
                ha_discovery_networks: 'not-an-array'
            };
            const result = validator.validate(haSettings);
            expect(result).toBe(false);
        });

        it('should accept valid HA discovery settings', () => {
            const haSettings = { 
                ...validSettings, 
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_networks: [254, 255]
            };
            const result = validator.validate(haSettings);
            expect(result).toBe(true);
        });

        it('should skip HA validation when disabled', () => {
            const haDisabledSettings = { 
                ...validSettings, 
                ha_discovery_enabled: false,
                ha_discovery_prefix: '', // Invalid but should be ignored
                ha_discovery_networks: 'invalid' // Invalid but should be ignored
            };
            const result = validator.validate(haDisabledSettings);
            expect(result).toBe(true);
        });
    });

    describe('validateWithWarnings', () => {
        it('should return validation result and emit warnings', () => {
            const settingsWithoutAuth = { ...validSettings };
            delete settingsWithoutAuth.cgateusername;
            delete settingsWithoutAuth.mqttusername;
            delete settingsWithoutAuth.getallnetapp;
            
            const result = validator.validateWithWarnings(settingsWithoutAuth);
            expect(result).toBe(true);
        });

        it('should warn about disabled HA discovery', () => {
            const settingsWithoutHA = { 
                ...validSettings, 
                ha_discovery_enabled: false 
            };
            const result = validator.validateWithWarnings(settingsWithoutHA);
            expect(result).toBe(true);
        });

        it('should not warn when authentication is configured', () => {
            const settingsWithAuth = { 
                ...validSettings,
                cgateusername: 'user',
                cgatepassword: 'pass',
                mqttusername: 'mqttuser',
                mqttpassword: 'mqttpass',
                getallnetapp: '254/56'
            };
            const result = validator.validateWithWarnings(settingsWithAuth);
            expect(result).toBe(true);
        });

        it('should return false for invalid settings even with warnings', () => {
            const invalidSettings = { ...validSettings, mqtt: null };
            const result = validator.validateWithWarnings(invalidSettings);
            expect(result).toBe(false);
        });
    });

    describe('validateSetup', () => {
        it('should return isFirstTime true for empty settings object', () => {
            const result = validator.validateSetup({});
            expect(result.isFirstTime).toBe(true);
            expect(result.message).toContain('No configuration found');
        });

        it('should return isFirstTime true for null/undefined settings', () => {
            const result = validator.validateSetup(null);
            expect(result.isFirstTime).toBe(true);
        });

        it('should return isFirstTime false for non-empty settings', () => {
            const result = validator.validateSetup(validSettings);
            expect(result.isFirstTime).toBe(false);
        });

        it('should add recommendation when cbusip is placeholder', () => {
            const settings = { ...validSettings, cbusip: 'your-cgate-ip' };
            const result = validator.validateSetup(settings);
            expect(result.recommendations).toContain('Update cbusip to match your actual C-Gate server IP address');
        });

        it('should add recommendation when cbusip is missing', () => {
            const settings = { ...validSettings };
            delete settings.cbusip;
            const result = validator.validateSetup(settings);
            expect(result.recommendations).toContain('Update cbusip to match your actual C-Gate server IP address');
        });

        it('should add recommendation when cbusname is CLIPSAL', () => {
            const settings = { ...validSettings, cbusname: 'CLIPSAL' };
            const result = validator.validateSetup(settings);
            expect(result.recommendations).toContain('Update cbusname to match your actual C-Bus project name');
        });

        it('should add recommendation when mqtt is localhost in production', () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            try {
                const settings = { ...validSettings, mqtt: 'localhost:1883' };
                const result = validator.validateSetup(settings);
                expect(result.recommendations).toContain('Consider updating MQTT broker address for production deployment');
            } finally {
                process.env.NODE_ENV = originalEnv;
            }
        });

        it('should add issue when MQTT auth is missing in production', () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            try {
                const settings = { ...validSettings, mqtt: 'broker.example.com:1883' };
                delete settings.mqttusername;
                delete settings.mqttpassword;
                const result = validator.validateSetup(settings);
                expect(result.issues).toContain('MQTT authentication is recommended for production environments');
                expect(result.isValid).toBe(false);
            } finally {
                process.env.NODE_ENV = originalEnv;
            }
        });

        it('should return isValid true when no issues in production', () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            try {
                const settings = {
                    ...validSettings,
                    mqtt: 'broker.example.com:1883',
                    mqttusername: 'user',
                    mqttpassword: 'pass'
                };
                const result = validator.validateSetup(settings);
                expect(result.isValid).toBe(true);
            } finally {
                process.env.NODE_ENV = originalEnv;
            }
        });

        it('should return empty issues and recommendations for clean non-production settings', () => {
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'test';
            try {
                const result = validator.validateSetup(validSettings);
                expect(result.isFirstTime).toBe(false);
                expect(result.issues).toEqual([]);
                expect(result.isValid).toBe(true);
            } finally {
                process.env.NODE_ENV = originalEnv;
            }
        });
    });

    describe('exitOnError behavior', () => {
        it('should not exit when exitOnError is false', () => {
            const noExitValidator = new SettingsValidator({ exitOnError: false });
            const invalidSettings = { ...validSettings, mqtt: null };
            
            // Should not throw or exit
            const result = noExitValidator.validate(invalidSettings);
            expect(result).toBe(false);
        });

        it('should exit when exitOnError is true', () => {
            const exitValidator = new SettingsValidator({ exitOnError: true });
            const invalidSettings = { ...validSettings, mqtt: null };
            
            // Mock process.exit to test behavior
            const originalExit = process.exit;
            process.exit = jest.fn();
            
            try {
                exitValidator.validate(invalidSettings);
                expect(process.exit).toHaveBeenCalledWith(1);
            } finally {
                process.exit = originalExit;
            }
        });
    });
});

describe('cbusRawEventLogApps validation', () => {
    const base = { mqtt: 'localhost:1883', cbusname: 'HOME', cbusip: '192.168.1.100', cbuscommandport: 20023, cbuseventport: 20025, messageinterval: 200, ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant', ha_discovery_networks: [254] };
    it('accepts an array of app IDs', () => {
        const v = new SettingsValidator({ exitOnError: false });
        expect(v.validate({ ...base, cbusRawEventLogApps: ['172', 228] })).toBe(true);
    });
    it('accepts an empty array (default)', () => {
        const v = new SettingsValidator({ exitOnError: false });
        expect(v.validate({ ...base, cbusRawEventLogApps: [] })).toBe(true);
    });
    it('rejects a non-array value', () => {
        const v = new SettingsValidator({ exitOnError: false });
        expect(v.validate({ ...base, cbusRawEventLogApps: '172' })).toBe(false);
    });
    it('rejects array entries that are not string/number', () => {
        const v = new SettingsValidator({ exitOnError: false });
        expect(v.validate({ ...base, cbusRawEventLogApps: [{}] })).toBe(false);
    });
});

describe('Module exports', () => {
    let validSettings;

    beforeEach(() => {
        validSettings = {
            mqtt: 'localhost:1883',
            cbusname: 'HOME',
            cbusip: '192.168.1.100',
            cbuscommandport: 20023,
            cbuseventport: 20025,
            messageinterval: 200
        };
    });

    describe('validate function', () => {
        it('should use default validator instance', () => {
            // Mock process.exit since default validator has exitOnError: true
            const originalExit = process.exit;
            process.exit = jest.fn();
            
            try {
                const invalidSettings = { ...validSettings, mqtt: null };
                validate(invalidSettings);
                expect(process.exit).toHaveBeenCalledWith(1);
            } finally {
                process.exit = originalExit;
            }
        });

        it('should return true for valid settings', () => {
            const result = validate(validSettings);
            expect(result).toBe(true);
        });
    });

    describe('validateWithWarnings function', () => {
        it('should use default validator instance with warnings', () => {
            const result = validateWithWarnings(validSettings);
            expect(result).toBe(true);
        });
    });

    describe('createValidator function', () => {
        it('should create validator with custom options', () => {
            const customValidator = createValidator({ exitOnError: false });
            expect(customValidator).toBeInstanceOf(SettingsValidator);

            const invalidSettings = { ...validSettings, mqtt: null };
            const result = customValidator.validate(invalidSettings);
            expect(result).toBe(false);
        });
    });

    describe('validateSetup function', () => {
        it('should return isFirstTime when no settings provided', () => {
            const { validateSetup } = require('../src/settingsValidator');
            const result = validateSetup({});
            expect(result.isFirstTime).toBe(true);
            expect(result.message).toBeDefined();
        });
    });
});