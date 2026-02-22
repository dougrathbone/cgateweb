const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Integration tests that validate the addon configuration files
 * are consistent with the ConfigLoader and CgateManager expectations.
 */
describe('Addon Configuration Integration', () => {
    let configYaml;

    beforeAll(() => {
        const configPath = path.join(__dirname, '../../homeassistant-addon/config.yaml');
        const configContent = fs.readFileSync(configPath, 'utf8');
        configYaml = yaml.parse(configContent);
    });

    describe('config.yaml structure', () => {
        test('should have required addon metadata', () => {
            expect(configYaml.name).toBe('C-Gate Web Bridge');
            expect(configYaml.slug).toBe('cgateweb');
            expect(configYaml.version).toBeDefined();
            expect(configYaml.description).toBeDefined();
            expect(configYaml.arch).toBeInstanceOf(Array);
            expect(configYaml.arch.length).toBeGreaterThan(0);
        });

        test('should support common architectures', () => {
            expect(configYaml.arch).toContain('aarch64');
            expect(configYaml.arch).toContain('amd64');
        });

        test('should use host networking', () => {
            expect(configYaml.host_network).toBe(true);
        });

        test('should mount share for C-Gate uploads', () => {
            expect(configYaml.map).toContain('share:ro');
        });
    });

    describe('options and schema consistency', () => {
        test('every option should have a corresponding schema entry', () => {
            const options = Object.keys(configYaml.options);
            const schema = Object.keys(configYaml.schema);

            for (const opt of options) {
                expect(schema).toContain(opt);
            }
        });

        test('every schema entry should have a corresponding option', () => {
            const options = Object.keys(configYaml.options);
            const schema = Object.keys(configYaml.schema);

            for (const sch of schema) {
                expect(options).toContain(sch);
            }
        });

        test('cgate_mode should have remote and managed options', () => {
            expect(configYaml.options.cgate_mode).toBe('remote');
            expect(configYaml.schema.cgate_mode).toContain('remote');
            expect(configYaml.schema.cgate_mode).toContain('managed');
        });

        test('cgate_install_source should have download and upload options', () => {
            expect(configYaml.options.cgate_install_source).toBe('download');
            expect(configYaml.schema.cgate_install_source).toContain('download');
            expect(configYaml.schema.cgate_install_source).toContain('upload');
        });

        test('port defaults should match cgateweb defaults', () => {
            expect(configYaml.options.cgate_port).toBe(20023);
            expect(configYaml.options.cgate_event_port).toBe(20025);
            expect(configYaml.options.mqtt_port).toBe(1883);
        });
    });

    describe('translations consistency', () => {
        let translations;

        beforeAll(() => {
            const translationsPath = path.join(__dirname, '../../homeassistant-addon/translations/en.yaml');
            const translationsContent = fs.readFileSync(translationsPath, 'utf8');
            translations = yaml.parse(translationsContent);
        });

        test('every config option should have a translation', () => {
            const options = Object.keys(configYaml.options);
            const translated = Object.keys(translations.configuration);

            for (const opt of options) {
                expect(translated).toContain(opt);
            }
        });

        test('every translation should correspond to a config option', () => {
            const options = Object.keys(configYaml.options);
            const translated = Object.keys(translations.configuration);

            for (const key of translated) {
                expect(options).toContain(key);
            }
        });

        test('translations should have name and description', () => {
            for (const [key, value] of Object.entries(translations.configuration)) {
                expect(value.name).toBeDefined();
                expect(value.description).toBeDefined();
                expect(typeof value.name).toBe('string');
                expect(typeof value.description).toBe('string');
                expect(value.name.length).toBeGreaterThan(0);
                expect(value.description.length).toBeGreaterThan(0);
            }
        });
    });

    describe('build.yaml', () => {
        let buildYaml;

        beforeAll(() => {
            const buildPath = path.join(__dirname, '../../homeassistant-addon/build.yaml');
            const buildContent = fs.readFileSync(buildPath, 'utf8');
            buildYaml = yaml.parse(buildContent);
        });

        test('should have build_from for all supported architectures', () => {
            for (const arch of configYaml.arch) {
                expect(buildYaml.build_from[arch]).toBeDefined();
                expect(buildYaml.build_from[arch]).toContain('ghcr.io/home-assistant/');
            }
        });

        test('should define required build args', () => {
            expect(buildYaml.args).toBeDefined();
            expect(buildYaml.args.BUILD_DATE).toBeDefined();
            expect(buildYaml.args.BUILD_REF).toBeDefined();
            expect(buildYaml.args.BUILD_VERSION).toBeDefined();
        });
    });

    describe('ConfigLoader addon options mapping', () => {
        test('should correctly map all config.yaml defaults to cgateweb settings', () => {
            const ConfigLoader = require('../../src/config/ConfigLoader');

            const optionsJson = JSON.stringify(configYaml.options);
            const tmpPath = path.join(__dirname, '../../.tmp-test-options.json');

            fs.writeFileSync(tmpPath, optionsJson);

            try {
                const mockDetector = {
                    detect: () => ({
                        type: 'addon',
                        isAddon: true,
                        optionsPath: tmpPath
                    }),
                    getEnvironmentInfo: () => ({ type: 'addon', isAddon: true }),
                    reset: () => {}
                };

                const loader = new ConfigLoader({ environmentDetector: mockDetector });
                const config = loader.load();

                expect(config.cbusip).toBe(configYaml.options.cgate_host || 'your-cgate-ip');
                expect(config.cbuscommandport).toBe(configYaml.options.cgate_port);
                expect(config.cbuseventport).toBe(configYaml.options.cgate_event_port);
                expect(config.cbusname).toBe(configYaml.options.cgate_project);
                expect(config.cgate_mode).toBe(configYaml.options.cgate_mode);
            } finally {
                fs.unlinkSync(tmpPath);
            }
        });
    });
});
