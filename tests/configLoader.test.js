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

    describe('add-on options for unit-type classification (issues #38, #37)', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'addon', isAddon: true, optionsPath: '/data/options.json' })
            }
        });

        const addonOptions = (extra) => ({
            cgate_host: '192.168.1.100',
            ha_discovery_enabled: true,
            ...extra
        });

        // Without an ADDON_OPTION_MAP row the toggle renders in the add-on UI and
        // silently does nothing, so pin the mapping rather than assume it.
        it('carries ha_discovery_type_from_unit through the add-on conversion', () => {
            const config = newLoader()._convertAddonOptionsToSettings(
                addonOptions({ ha_discovery_type_from_unit: true })
            );

            expect(config.ha_discovery_type_from_unit).toBe(true);
        });

        it('maps an explicit false through as false', () => {
            const config = newLoader()._convertAddonOptionsToSettings(
                addonOptions({ ha_discovery_type_from_unit: false })
            );

            expect(config.ha_discovery_type_from_unit).toBe(false);
        });

        it('leaves the setting unset when the add-on option is absent', () => {
            const config = newLoader()._convertAddonOptionsToSettings(addonOptions());

            expect(config.ha_discovery_type_from_unit).toBeUndefined();
        });
    });

    describe('add-on serial PC Interface option (issue #28)', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'addon', isAddon: true, optionsPath: '/data/options.json' })
            }
        });

        // Without this, SerialDeviceRecovery never sees a serial device and the
        // in-flight replug recovery is dead code in the add-on.
        it('carries cgate_serial_device through in managed mode', () => {
            const config = newLoader()._convertAddonOptionsToSettings({
                cgate_mode: 'managed',
                cgate_serial_device: '/dev/serial/by-id/usb-pci'
            });

            expect(config.cgate_serial_device).toBe('/dev/serial/by-id/usb-pci');
        });

        it('ignores it in remote mode, where C-Gate runs on another machine', () => {
            const config = newLoader()._convertAddonOptionsToSettings({
                cgate_host: '192.168.1.100',
                cgate_serial_device: '/dev/ttyUSB0'
            });

            expect(config.cgate_serial_device).toBeUndefined();
        });

        it('leaves it unset when the option is absent', () => {
            const config = newLoader()._convertAddonOptionsToSettings({ cgate_mode: 'managed' });

            expect(config.cgate_serial_device).toBeUndefined();
        });
    });
});
