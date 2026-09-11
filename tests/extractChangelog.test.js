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

    it('stops the live changelog at the next version heading', () => {
        const fs = require('fs');
        const path = require('path');
        const markdown = fs.readFileSync(
            path.join(__dirname, '..', 'homeassistant-addon', 'CHANGELOG.md'),
            'utf8'
        );
        const current = require('../package.json').version;
        const headings = [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
        expect(headings[0]).toBe(current);
        const parts = current.split('.').map(Number);
        if (parts[2] > 0) {
            expect(headings[1]).toBe(`${parts[0]}.${parts[1]}.${parts[2] - 1}`);
        } else {
            expect(headings[1]).toBeDefined();
        }
        const section = extractChangelogSection(markdown, current);
        expect(section).toContain(`## [${current}]`);
        expect(section).not.toContain(`## [${headings[1]}]`);
        const previous = extractChangelogSection(markdown, headings[1]);
        expect(previous).toContain(`## [${headings[1]}]`);
        expect(previous).not.toContain(`## [${current}]`);
    });
});
