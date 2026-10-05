const fs = require('fs');
const path = require('path');
const {
    releaseHeading,
    validateArchiveChangelog,
    validateChangelogSplit,
    validateLiveChangelog
} = require('../tools/validate-changelog');

function live(versions) {
    return `# Changelog\n\n${versions.join('\n\n')}\n`;
}

function version(number, body, date = '2026-01-02') {
    return `${releaseHeading(number, date)}\n\n${body}`;
}

const FIXED = `### Fixed\n\n- **Lights recover after a restart.**`;

describe('validateLiveChangelog', () => {
    const ok = live([
        version('1.2.0', FIXED, '2026-02-02'),
        version('1.1.0', FIXED, '2026-01-02')
    ]);

    it('accepts a short dated changelog', () => {
        expect(validateLiveChangelog(ok, { currentVersion: '1.2.0' })).toEqual([]);
    });

    it('rejects placeholder text and backticks', () => {
        const notes = live([version('1.2.0', '### Fixed\n\n- **Coming soon.** `topic`')]);
        const errors = validateLiveChangelog(notes);
        expect(errors.some((error) => /placeholder/.test(error))).toBe(true);
        expect(errors.some((error) => /backticks/.test(error))).toBe(true);
    });

    it('rejects a heading without a date or release link', () => {
        const notes = '# Changelog\n\n## [1.2.0] - TBD\n\n### Fixed\n\n- **Lights recover.**\n';
        const errors = validateLiveChangelog(notes);
        expect(errors.some((error) => /version heading/.test(error))).toBe(true);
    });

    it('rejects an empty or out-of-order section', () => {
        const notes = live([version('1.2.0', '### Fixed\n\n### Added\n\n- **A new sensor.**')]);
        const errors = validateLiveChangelog(notes);
        expect(errors.some((error) => /Fixed has no bullets/.test(error))).toBe(true);
        expect(errors.some((error) => /out of section order/.test(error))).toBe(true);
    });

    it('rejects a bare issue number, an internal note, and a long bullet', () => {
        const long = `**${'word '.repeat(41).trim()}**`;
        const notes = live([version('1.2.0', `### Fixed\n\n- **Broken.** (#12)\n- Internal: hidden\n- ${long}`)]);
        const errors = validateLiveChangelog(notes);
        expect(errors.some((error) => /bare issue number/.test(error))).toBe(true);
        expect(errors.some((error) => /internal notes/.test(error))).toBe(true);
        expect(errors.some((error) => /words/.test(error))).toBe(true);
    });

    it('requires a full issue link and a matching release version', () => {
        const badLink = live([version('1.2.0', '### Fixed\n\n- **Broken.** ([#12](https://github.com/dougrathbone/cgateweb/issues/99))')]);
        expect(validateLiveChangelog(badLink).some((error) => /issue #12/.test(error))).toBe(true);

        const badRelease = live([
            '## [1.2.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.1.0) - 2026-02-02\n\n### Fixed\n\n- **Lights recover.**'
        ]);
        expect(validateLiveChangelog(badRelease).some((error) => /links to release 1.1.0/.test(error))).toBe(true);
    });

    it('allows an unpublished version only when the note says where it shipped', () => {
        const missing = live([
            '## [1.2.0] - 2026-02-02\n\n### Changed\n\n- **Maintenance release; no user-facing changes.**'
        ]);
        expect(validateLiveChangelog(missing).some((error) => /not published/.test(error))).toBe(true);

        const noted = live([
            '## [1.2.0] - 2026-02-02\n\n**This version was not published.** Its changes are included from 1.2.1.\n\n### Fixed\n\n- **Lights recover.**'
        ]);
        expect(validateLiveChangelog(noted)).toEqual([]);
    });

    it('rejects a version newer than the package version at the top', () => {
        const errors = validateLiveChangelog(ok, { currentVersion: '1.1.0' });
        expect(errors.some((error) => /package version/.test(error))).toBe(true);
    });
});

describe('validateArchiveChangelog', () => {
    it('requires a date and an unpublished note when there is no release link', () => {
        const notes = '## [1.0.0] - TBD\n\n### Added\n\n- Initial release.\n';
        const errors = validateArchiveChangelog(notes);
        expect(errors.some((error) => /version heading|placeholder/.test(error))).toBe(true);
    });

    it('accepts a linked release and a not-published note', () => {
        const notes = [
            `${releaseHeading('1.1.0', '2026-02-02')}`,
            '',
            '### Fixed',
            '',
            '- Older wording with `code`.',
            '',
            '## [1.0.0] - 2026-02-01',
            '',
            '**This version was not published.** It never reached the add-on repository.',
            ''
        ].join('\n');
        expect(validateArchiveChangelog(notes)).toEqual([]);
    });
});

describe('the shipped changelogs', () => {
    const root = path.join(__dirname, '..', 'homeassistant-addon');
    const live = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const archive = fs.readFileSync(path.join(root, 'CHANGELOG-archive.md'), 'utf8');
    const version = require('../package.json').version;

    it('match the changelog rules', () => {
        expect(validateLiveChangelog(live, { currentVersion: version })).toEqual([]);
        expect(validateArchiveChangelog(archive)).toEqual([]);
        expect(validateChangelogSplit(live, archive)).toEqual([]);
    });

    it('keeps upgrade facts that are easy to miss', () => {
        expect(live).toContain('The 1.34.14 fix covered the same message only when C-Gate was left in server mode.');
        expect(live).toContain('**This version was not published.** It had no user-facing changes. Install 1.34.1 or later.');
        expect(live).toContain('### Action required');
        expect(live).not.toContain('Internal:');
        expect(archive).toContain('## [1.0.0](https://github.com/dougrathbone/cgateweb-homeassistant/releases/tag/v1.0.0) - 2026-02-22');
        expect(archive).toContain('**This version was not published.** Its changes are included from 1.11.1.');
        expect(archive).not.toContain('TBD');
    });
});
