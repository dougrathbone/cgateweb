const { collectKeys, diffKeys, validateTranslations } = require('../tools/validate-translations');

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
});
