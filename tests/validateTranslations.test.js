const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const {
    collectKeys,
    diffKeys,
    validateTranslations,
    listLocaleFiles,
    validateCatalogFreshness,
    validateCatalogLocales
} = require('../tools/validate-translations');
const {
    SUPPORTED_LOCALES,
    CATALOG_NAME,
    buildLocaleDoc,
    stringifyLocaleDoc,
    generateLocaleYamlMap,
    localesInCatalog,
    validateCatalogCompleteness
} = require('../tools/generate-translations');

describe('validate-translations', () => {
    describe('collectKeys', () => {
        it('collects section.childKey for each child of each section', () => {
            const doc = {
                configuration: {
                    cgate_mode: { name: 'Mode', description: 'x' },
                    log_level: { name: 'Log', description: 'y' },
                },
                network: {
                    '8080/tcp': { name: 'Web' },
                },
            };
            expect(collectKeys(doc)).toEqual(
                new Set(['configuration.cgate_mode', 'configuration.log_level', 'network.8080/tcp'])
            );
        });

        it('returns an empty set for a null or empty document', () => {
            expect(collectKeys(null).size).toBe(0);
            expect(collectKeys({}).size).toBe(0);
        });
    });

    describe('diffKeys', () => {
        it('reports missing and extra keys relative to the source', () => {
            const source = new Set(['configuration.a', 'configuration.b']);
            const keys = new Set(['configuration.a', 'configuration.c']);
            expect(diffKeys(source, keys)).toEqual({
                missing: ['configuration.b'],
                extra: ['configuration.c'],
            });
        });
    });

    describe('validateTranslations', () => {
        const en = { configuration: { a: { name: 'A' }, b: { name: 'B' } } };

        it('passes when every file has the same keys as the source', () => {
            const docs = {
                'en.yaml': en,
                'de.yaml': { configuration: { a: { name: 'A-de' }, b: { name: 'B-de' } } },
            };
            expect(validateTranslations(docs)).toEqual([]);
        });

        it('flags a file missing a key present in the source', () => {
            const docs = {
                'en.yaml': en,
                'fr.yaml': { configuration: { a: { name: 'A-fr' } } },
            };
            const errors = validateTranslations(docs);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('fr.yaml');
            expect(errors[0]).toContain('configuration.b');
        });

        it('flags a file with an extra key not in the source', () => {
            const docs = {
                'en.yaml': en,
                'es.yaml': { configuration: { a: {}, b: {}, stale_option: {} } },
            };
            const errors = validateTranslations(docs);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('es.yaml');
            expect(errors[0]).toContain('stale_option');
        });

        it('does not compare the source file against itself', () => {
            expect(validateTranslations({ 'en.yaml': en })).toEqual([]);
        });
    });

    describe('listLocaleFiles', () => {
        it('skips catalog.yaml when scanning locale yaml files', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgateweb-i18n-'));
            try {
                fs.writeFileSync(path.join(dir, 'en.yaml'), 'configuration: {}\n');
                fs.writeFileSync(path.join(dir, 'de.yaml'), 'configuration: {}\n');
                fs.writeFileSync(path.join(dir, CATALOG_NAME), 'configuration: {}\n');
                expect(listLocaleFiles(dir).sort()).toEqual(['de.yaml', 'en.yaml']);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('validateCatalogLocales', () => {
        it('fails when a supported locale is absent from the catalog', () => {
            const catalog = {
                configuration: {
                    a: {
                        name: Object.fromEntries(
                            SUPPORTED_LOCALES.filter((l) => l !== 'uk').map((l) => [l, `n-${l}`])
                        ),
                    },
                },
            };
            const errors = validateCatalogLocales(catalog);
            expect(errors.some((e) => e.includes('"uk"'))).toBe(true);
        });

        it('passes when every supported locale appears in the catalog', () => {
            const catalog = {
                configuration: {
                    a: {
                        name: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `n-${l}`])),
                    },
                },
            };
            expect(validateCatalogLocales(catalog)).toEqual([]);
            expect(localesInCatalog(catalog)).toEqual(new Set(SUPPORTED_LOCALES));
        });
    });

    describe('validateCatalogFreshness', () => {
        it('fails when a committed locale yaml differs from catalog output', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgateweb-i18n-'));
            try {
                const catalog = {
                    configuration: {
                        a: {
                            name: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `Name ${l}`])),
                            description: Object.fromEntries(
                                SUPPORTED_LOCALES.map((l) => [l, `Desc ${l}`])
                            ),
                        },
                    },
                };
                const expected = generateLocaleYamlMap(catalog);
                for (const locale of SUPPORTED_LOCALES) {
                    const content =
                        locale === 'de' ? 'configuration:\n  stale: true\n' : expected[locale];
                    fs.writeFileSync(path.join(dir, `${locale}.yaml`), content);
                }
                const errors = validateCatalogFreshness(catalog, dir);
                expect(errors.some((e) => e.includes('de.yaml') && e.includes('stale'))).toBe(
                    true
                );
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});

describe('generate-translations', () => {
    it('round-trips catalog option keys into each locale document', () => {
        const catalog = {
            configuration: {
                cgate_mode: {
                    name: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `Mode ${l}`])),
                    description: Object.fromEntries(
                        SUPPORTED_LOCALES.map((l) => [l, `Description for ${l}`])
                    ),
                },
                log_level: {
                    name: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `Log ${l}`])),
                    description: Object.fromEntries(
                        SUPPORTED_LOCALES.map((l) => [l, `Log desc ${l}`])
                    ),
                },
            },
        };

        const enKeys = collectKeys(buildLocaleDoc(catalog, 'en'));
        expect(enKeys).toEqual(
            new Set(['configuration.cgate_mode', 'configuration.log_level'])
        );

        for (const locale of SUPPORTED_LOCALES) {
            const doc = buildLocaleDoc(catalog, locale);
            expect(collectKeys(doc)).toEqual(enKeys);
            expect(doc.configuration.cgate_mode.name).toBe(`Mode ${locale}`);
            expect(doc.configuration.cgate_mode.description).toBe(`Description for ${locale}`);

            const yamlText = stringifyLocaleDoc(doc);
            const parsed = YAML.parse(yamlText);
            expect(collectKeys(parsed)).toEqual(enKeys);
            expect(parsed.configuration.log_level.name).toBe(`Log ${locale}`);
        }
    });

    it('flags a locale missing from an option description', () => {
        const catalog = {
            configuration: {
                cgate_mode: {
                    name: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `Mode ${l}`])),
                    description: Object.fromEntries(
                        SUPPORTED_LOCALES.filter((l) => l !== 'de').map((l) => [l, `Desc ${l}`])
                    )
                }
            }
        };
        const errors = validateCatalogCompleteness(catalog);
        expect(errors.some((e) => e.includes('cgate_mode.description.de'))).toBe(true);
    });
});
