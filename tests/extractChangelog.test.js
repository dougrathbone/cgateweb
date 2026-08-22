const { extractChangelogSection } = require('../tools/extract-changelog');

describe('extractChangelogSection', () => {
    const md = `# Changelog

## [1.27.0] - 2026-08-21

### Added

- First item.

## [1.26.0] - 2026-08-15

### Fixed

- Older item.
`;

    it('returns the named version including its heading', () => {
        const section = extractChangelogSection(md, '1.27.0');
        expect(section).toContain('## [1.27.0] - 2026-08-21');
        expect(section).toContain('First item.');
        expect(section).not.toContain('1.26.0');
    });

    it('returns the last section when it is the oldest remaining heading', () => {
        const section = extractChangelogSection(md, '1.26.0');
        expect(section).toContain('Older item.');
        expect(section).not.toContain('1.27.0');
    });

    it('throws when the version is missing', () => {
        expect(() => extractChangelogSection(md, '9.9.9')).toThrow(/no CHANGELOG section/);
    });

    it('rejects a non-semver argument rather than interpolating it', () => {
        expect(() => extractChangelogSection(md, '1.27.0-rc.1')).toThrow(/invalid version/);
        expect(() => extractChangelogSection(md, '.*')).toThrow(/invalid version/);
    });
});
