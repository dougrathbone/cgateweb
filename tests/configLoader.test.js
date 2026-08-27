const ConfigLoader = require('../src/config/ConfigLoader');
const {
    listSchemaEntries,
    listSettingAliases,
    INTERNAL_CONFIG_KEYS,
    buildDefaults
} = require('../src/config/schema');

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

        // These two are read by real code paths - getall_networks by
        // bridgeInitializationService's poll-target resolution, the keyword map
        // by deviceTypeClassifier - but were absent from defaultSettings, which
        // is where the known-key set comes from. Anyone who set them was told
        // they were a typo that "will be ignored by defaults", and both halves
        // of that sentence were untrue.
        it.each([
            ['getall_networks', [254]],
            ['ha_discovery_security_device_class_keywords', { garage: 'garage_door' }]
        ])('does not report %s as a typo, because the code reads it', (key, value) => {
            const loader = new ConfigLoader({
                environmentDetector: {
                    detect: () => ({
                        type: 'standalone',
                        isAddon: false,
                        settingsPath: '/tmp/settings.js'
                    })
                }
            });
            const warnSpy = jest.spyOn(loader.logger, 'warn');

            loader._convertSettingsToStandardFormat({
                cbusip: '192.168.1.100',
                mqtt: 'mqtt://localhost',
                [key]: value
            });

            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(key));
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

    describe('known-key vocabulary derived from the schema', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'standalone', isAddon: false, settingsPath: '/fake/path' })
            }
        });

        // The false-typo bug was "the known-key set is Object.keys(defaults)
        // plus a hand-maintained list", so anything read but not defaulted was
        // reported as an ignored typo. These three assert the vocabulary now
        // comes from the schema and covers everything the schema declares.
        it('accepts every canonical setting key without warning', () => {
            const loader = newLoader();
            const warnSpy = jest.spyOn(loader.logger, 'warn');

            const settings = {};
            for (const entry of listSchemaEntries()) {
                settings[entry.key] = entry.default;
            }
            loader._convertSettingsToStandardFormat(settings);

            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('accepts every alias without warning', () => {
            const loader = newLoader();
            const warnSpy = jest.spyOn(loader.logger, 'warn');

            const settings = {};
            for (const alias of listSettingAliases().keys()) {
                settings[alias] = 'value';
            }
            loader._convertSettingsToStandardFormat(settings);

            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('accepts every internal key without warning', () => {
            const loader = newLoader();
            const warnSpy = jest.spyOn(loader.logger, 'warn');

            const settings = {};
            for (const key of Object.keys(INTERNAL_CONFIG_KEYS)) {
                settings[key] = 'value';
            }
            loader._convertSettingsToStandardFormat(settings);

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('add-on option names accepted as aliases in settings.js', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'standalone', isAddon: false, settingsPath: '/fake/path' })
            }
        });

        // The motivating case: someone reads homeassistant-addon/DOCS.md, writes
        // the add-on option name into settings.js, and used to get a typo
        // warning and silence.
        it('maps cgate_host onto cbusip and says so', () => {
            const loader = newLoader();
            const infoSpy = jest.spyOn(loader.logger, 'info');
            const warnSpy = jest.spyOn(loader.logger, 'warn');

            const config = loader._convertSettingsToStandardFormat({ cgate_host: '10.0.0.5' });

            expect(config.cbusip).toBe('10.0.0.5');
            expect(config.cgate_host).toBeUndefined();
            expect(warnSpy).not.toHaveBeenCalled();
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"cgate_host"'));
        });

        it.each([
            ['cgate_project', 'HOME', 'cbusname', 'HOME'],
            ['cgate_port', 20123, 'cbuscommandport', 20123],
            ['cgate_event_port', 20125, 'cbuseventport', 20125],
            ['mqtt_username', 'bridge', 'mqttusername', 'bridge'],
            ['mqtt_password', 'secret', 'mqttpassword', 'secret'],
            ['mqtt_ca_file', '/ssl/ca.pem', 'mqttCaFile', '/ssl/ca.pem'],
            ['mqtt_use_tls', true, 'mqttUseTls', true],
            ['mqtt_reject_unauthorized', false, 'mqttRejectUnauthorized', false],
            ['retain_reads', true, 'retainreads', true],
            ['getall_on_start', true, 'getallonstart', true],
            ['getall_period', 3600, 'getallperiod', 3600],
            ['message_interval', 500, 'messageinterval', 500],
            ['connection_pool_size', 5, 'connectionPoolSize', 5],
            ['auto_discover_networks', false, 'autoDiscoverNetworks', false]
        ])('maps %s onto %s', (alias, value, canonicalKey, expected) => {
            const config = newLoader()._convertSettingsToStandardFormat({ [alias]: value });

            expect(config[canonicalKey]).toBe(expected);
            expect(config[alias]).toBeUndefined();
        });

        it('lets the canonical key win when both are set', () => {
            // Aliases are additive: an existing settings.js must resolve to
            // exactly what it resolved to before they existed.
            const loader = newLoader();
            const infoSpy = jest.spyOn(loader.logger, 'info');

            const config = loader._convertSettingsToStandardFormat({
                cbusip: '192.168.1.100',
                cgate_host: '10.0.0.5'
            });

            expect(config.cbusip).toBe('192.168.1.100');
            expect(config.cgate_host).toBeUndefined();
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring "cgate_host"'));
        });

        it('lets a falsy canonical value still win over an alias', () => {
            // `false` and 0 are meaningful settings values, so "canonical wins"
            // cannot be a truthiness test.
            const config = newLoader()._convertSettingsToStandardFormat({
                retainreads: false,
                retain_reads: true
            });

            expect(config.retainreads).toBe(false);
        });

        it('coerces a string boolean alias, exactly as the old auto_discover_networks bridge did', () => {
            const config = newLoader()._convertSettingsToStandardFormat({
                auto_discover_networks: 'false'
            });

            expect(config.autoDiscoverNetworks).toBe(false);
        });

        it.each([
            ['true', true],
            [true, true],
            ['false', false],
            [false, false]
        ])('still maps auto_discover_networks %p to %p through the general mechanism', (value, expected) => {
            const config = newLoader()._convertSettingsToStandardFormat({
                auto_discover_networks: value
            });

            expect(config.autoDiscoverNetworks).toBe(expected);
            expect(config.auto_discover_networks).toBeUndefined();
        });

        it('leaves a non-boolean setting uncoerced', () => {
            const config = newLoader()._convertSettingsToStandardFormat({ cgate_port: '20023' });

            expect(config.cbuscommandport).toBe('20023');
        });

        it('does not invent a canonical key when the alias is absent', () => {
            const config = newLoader()._convertSettingsToStandardFormat({ cbusip: '192.168.1.100' });

            expect(Object.keys(config)).toEqual(['cbusip']);
        });

        it('leaves every alias name off the resulting config', () => {
            // A leftover alias key would be spread over the defaults and end up
            // as a second, ignored copy of the setting.
            const settings = {};
            for (const alias of listSettingAliases().keys()) {
                settings[alias] = 'value';
            }
            const config = newLoader()._convertSettingsToStandardFormat(settings);

            const survivors = [...listSettingAliases().keys()]
                .filter((alias) => Object.prototype.hasOwnProperty.call(config, alias));
            expect(survivors).toEqual([]);
        });

        it('writes only real setting keys into the config', () => {
            const settings = {};
            for (const alias of listSettingAliases().keys()) {
                settings[alias] = 'value';
            }
            const config = newLoader()._convertSettingsToStandardFormat(settings);

            const defaults = buildDefaults();
            const unknown = Object.keys(config)
                .filter((key) => !Object.prototype.hasOwnProperty.call(defaults, key));
            expect(unknown).toEqual([]);
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

    describe('add-on raw event capture', () => {
        const newLoader = () => new ConfigLoader({
            environmentDetector: {
                detect: () => ({ type: 'addon', isAddon: true, optionsPath: '/data/options.json' })
            }
        });

        it('maps cbus_raw_event_log_apps onto cbusRawEventLogApps', () => {
            const config = newLoader()._convertAddonOptionsToSettings({
                cgate_host: '192.168.1.100',
                cbus_raw_event_log_apps: [172, 228]
            });
            expect(config.cbusRawEventLogApps).toEqual([172, 228]);
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
