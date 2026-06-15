const ConfigLoader = require('../src/config/ConfigLoader');

describe('ConfigLoader', () => {
    describe('unknown settings key warning', () => {
        it('should warn about unrecognized keys in settings.js config', () => {
            const loader = new ConfigLoader({
                environmentDetector: {
                    detect: () => ({
                        type: 'standalone',
                        isAddon: false,
                        settingsPath: '/fake/path'
                    })
                }
            });

            const warnSpy = jest.spyOn(loader.logger, 'warn');

            // Call the internal method directly with a typo key
            const settings = {
                cbusip: '192.168.1.100',
                mqtt: 'mqtt://localhost',
                cbusnmae: 'HOME' // typo of cbusname
            };
            loader._convertSettingsToStandardFormat(settings);

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Unknown setting "cbusnmae"')
            );
        });

        it('should not warn about known settings keys', () => {
            const loader = new ConfigLoader({
                environmentDetector: {
                    detect: () => ({
                        type: 'standalone',
                        isAddon: false,
                        settingsPath: '/fake/path'
                    })
                }
            });

            const warnSpy = jest.spyOn(loader.logger, 'warn');

            const settings = {
                cbusip: '192.168.1.100',
                mqtt: 'mqtt://localhost',
                cbusname: 'HOME'
            };
            loader._convertSettingsToStandardFormat(settings);

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('string boolean coercion in standalone settings', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'standalone', isAddon: false, settingsPath: '/fake/path' })
            }
        });

        it('should coerce cbus_aircon_control_enabled "false" string to boolean false', () => {
            const config = newLoader()._convertSettingsToStandardFormat({
                cbus_aircon_control_enabled: 'false'
            });

            expect(config.cbus_aircon_control_enabled).toBe(false);
        });

        it('should coerce cbus_aircon_control_enabled "true" string to boolean true', () => {
            const config = newLoader()._convertSettingsToStandardFormat({
                cbus_aircon_control_enabled: 'true'
            });

            expect(config.cbus_aircon_control_enabled).toBe(true);
        });

        it('should leave a real boolean cbus_aircon_control_enabled untouched', () => {
            const config = newLoader()._convertSettingsToStandardFormat({
                cbus_aircon_control_enabled: true
            });

            expect(config.cbus_aircon_control_enabled).toBe(true);
        });
    });
});
