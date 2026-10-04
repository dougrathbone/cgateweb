#!/usr/bin/env node
'use strict';

/**
 * CI guard for the add-on changelog.
 *
 * homeassistant-addon/CHANGELOG.md is what Home Assistant shows on upgrade.
 * It has to stay short, dated, and free of internal notes. Older releases live
 * in CHANGELOG-archive.md and only have to stay dated and honestly marked
 * when a version never reached the add-on repository.
 */

const fs = require('fs');
const path = require('path');

const SECTION_ORDER = [
    'Breaking changes',
    'Action required',
    'Added',
    'Fixed',
    'Changed',
    'Removed',
    'Security'
];

const MAX_BULLET_WORDS = 40;
const SOURCE_RELEASE = 'https://github.com/dougrathbone/cgateweb/releases/tag/v';
const PLACEHOLDER_RE = /\b(?:TBD|TODO|Unreleased|Coming soon|To be determined)\b/;
const HEADING_RE = /^## \[(\d+\.\d+\.\d+)\](?:\((https:\/\/github\.com\/dougrathbone\/cgateweb(?:-homeassistant)?\/releases\/tag\/v(\d+\.\d+\.\d+))\))? - (\d{4}-\d{2}-\d{2})$/;
const NOT_PUBLISHED_RE = /^\*\*This version was not published\.\*\* (?:Its changes are included from \d+\.\d+\.\d+\.|It had no user-facing changes\. Install \d+\.\d+\.\d+ or later\.|It never reached the add-on repository\.)$/;

function isRealDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return 0;
}

function parseHeading(line) {
    const match = HEADING_RE.exec(line);
    if (!match) {
        return null;
    }
    return {
        version: match[1],
        url: match[2] || null,
        urlVersion: match[3] || null,
        date: match[4]
    };
}

function listVersions(markdown) {
    return markdown.split('\n').map(parseHeading).filter(Boolean);
}

function placeholderErrors(markdown) {
    const errors = [];
    markdown.split('\n').forEach((line, index) => {
        if (PLACEHOLDER_RE.test(line)) {
            errors.push(`${index + 1}: placeholder text is not allowed in a release note`);
        }
    });
    return errors;
}

function orderErrors(versions) {
    const errors = [];
    const seen = new Set();
    versions.forEach((version, index) => {
        if (seen.has(version.version)) {
            errors.push(`${version.version} is listed more than once`);
        }
        seen.add(version.version);
        if (!isRealDate(version.date)) {
            errors.push(`${version.version} has an impossible date ${version.date}`);
        }
        if (version.url && version.urlVersion !== version.version) {
            errors.push(`${version.version} links to release ${version.urlVersion}`);
        }
        if (index > 0) {
            const previous = versions[index - 1];
            if (compareVersions(previous.version, version.version) <= 0) {
                errors.push(`${version.version} is not older than ${previous.version}`);
            }
            if (previous.date < version.date) {
                errors.push(`${version.version} is dated after ${previous.version}`);
            }
        }
    });
    return errors;
}

function bulletWordCount(line) {
    const text = line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^- /, '')
        .replace(/\*\*/g, '');
    return text.split(/\s+/).filter(Boolean).length;
}

function bulletErrors(line, lineNo) {
    const errors = [];
    if (!/^- \*\*[^*]+\*\*/.test(line)) {
        errors.push(`${lineNo}: bullet must lead with a bold outcome`);
    }
    if (line.includes('Internal:')) {
        errors.push(`${lineNo}: internal notes do not belong in the add-on changelog`);
    }
    if (/\(#\d+/.test(line)) {
        errors.push(`${lineNo}: use a full GitHub issue link, not a bare issue number`);
    }
    const links = line.matchAll(/\[#(\d+)\]\(([^)]*)\)/g);
    for (const link of links) {
        const expected = `https://github.com/dougrathbone/cgateweb/issues/${link[1]}`;
        if (link[2] !== expected) {
            errors.push(`${lineNo}: issue #${link[1]} must link to ${expected}`);
        }
    }
    const words = bulletWordCount(line);
    if (words > MAX_BULLET_WORDS) {
        errors.push(`${lineNo}: bullet is ${words} words; keep it to ${MAX_BULLET_WORDS}`);
    }
    return errors;
}

/**
 * @param {string} markdown
 * @param {{ currentVersion?: string }} [options]
 * @returns {string[]}
 */
function validateLiveChangelog(markdown, options = {}) {
    const errors = [
        ...placeholderErrors(markdown)
    ];
    markdown.split('\n').forEach((line, index) => {
        if (line.includes('`')) {
            errors.push(`${index + 1}: backticks are not allowed in the add-on changelog`);
        }
    });

    const lines = markdown.split('\n');
    const versions = [];
    let index = lines.findIndex((line) => line.startsWith('## ['));
    if (index === -1) {
        errors.push('no version headings');
        return errors;
    }

    while (index < lines.length) {
        const lineNo = index + 1;
        if (!lines[index].startsWith('## [')) {
            errors.push(`${lineNo}: unexpected text between versions`);
            index += 1;
            continue;
        }
        const version = parseHeading(lines[index]);
        if (!version) {
            errors.push(`${lineNo}: version heading must be a semver version, optional release link, and YYYY-MM-DD date`);
            index += 1;
            while (index < lines.length && !lines[index].startsWith('## [')) {
                index += 1;
            }
            continue;
        }
        versions.push(version);
        index += 1;

        let preface = false;
        let section = null;
        let sectionLine = 0;
        let sectionHasBullet = false;
        let sawSection = false;
        const seenSections = [];

        const finishSection = () => {
            if (section && !sectionHasBullet) {
                errors.push(`${sectionLine}: ${section} has no bullets`);
            }
        };

        while (index < lines.length && !lines[index].startsWith('## [')) {
            const line = lines[index];
            const currentLine = index + 1;
            index += 1;
            if (line.trim() === '') {
                continue;
            }
            if (NOT_PUBLISHED_RE.test(line)) {
                if (preface || sawSection) {
                    errors.push(`${currentLine}: the not-published note must be the first line of the version`);
                }
                preface = true;
                continue;
            }
            if (line.startsWith('**This version was not published.**')) {
                errors.push(`${currentLine}: not-published note must say where the changes shipped, or that there were none`);
                continue;
            }
            const sectionMatch = /^### (.+)$/.exec(line);
            if (sectionMatch) {
                finishSection();
                const name = sectionMatch[1];
                const order = SECTION_ORDER.indexOf(name);
                if (order === -1) {
                    errors.push(`${currentLine}: unknown section "${name}"`);
                } else if (seenSections.length > 0 && order <= seenSections[seenSections.length - 1]) {
                    errors.push(`${currentLine}: "${name}" is out of section order`);
                }
                if (order !== -1) {
                    seenSections.push(order);
                }
                section = name;
                sectionLine = currentLine;
                sectionHasBullet = false;
                sawSection = true;
                continue;
            }
            if (line.startsWith('- ')) {
                if (!section) {
                    errors.push(`${currentLine}: bullet is outside a section`);
                }
                sectionHasBullet = true;
                errors.push(...bulletErrors(line, currentLine));
                continue;
            }
            errors.push(`${currentLine}: unexpected changelog line`);
        }
        finishSection();
        if (!sawSection) {
            errors.push(`${lineNo}: ${version.version} has no sections`);
        }
        if (!version.url && !preface) {
            errors.push(`${lineNo}: ${version.version} needs a release link, or a note that it was not published`);
        }
    }

    errors.push(...orderErrors(versions));
    if (options.currentVersion && versions[0] && versions[0].version !== options.currentVersion) {
        errors.push(`first version ${versions[0].version} does not match package version ${options.currentVersion}`);
    }
    return errors;
}

/**
 * Archive notes keep their original wording. They still need real dates,
 * working release links, and an honest note when a version was never published.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function validateArchiveChangelog(markdown) {
    const errors = placeholderErrors(markdown);
    const lines = markdown.split('\n');
    const versions = [];

    lines.forEach((line, index) => {
        if (!line.startsWith('## [')) {
            return;
        }
        const version = parseHeading(line);
        if (!version) {
            errors.push(`${index + 1}: version heading must be a semver version, optional release link, and YYYY-MM-DD date`);
            return;
        }
        versions.push(version);
        let next = index + 1;
        while (next < lines.length && lines[next].trim() === '') {
            next += 1;
        }
        const note = lines[next] || '';
        const validNote = NOT_PUBLISHED_RE.test(note);
        if (note.startsWith('**This version was not published.**') && !validNote) {
            errors.push(`${next + 1}: not-published note must say where the changes shipped, or that there were none`);
        }
        if (!version.url && !validNote) {
            errors.push(`${index + 1}: ${version.version} needs a release link, or a note that it was not published`);
        }
    });

    errors.push(...orderErrors(versions));
    return errors;
}

/**
 * @param {string} live
 * @param {string} archive
 * @returns {string[]}
 */
function validateChangelogSplit(live, archive) {
    const liveVersions = listVersions(live).map((version) => version.version);
    const archiveVersions = listVersions(archive).map((version) => version.version);
    const errors = [];
    const archiveSet = new Set(archiveVersions);
    liveVersions.forEach((version) => {
        if (archiveSet.has(version)) {
            errors.push(`${version} is in both the changelog and the archive`);
        }
    });
    if (liveVersions.length > 0 && archiveVersions.length > 0) {
        const oldestLive = liveVersions[liveVersions.length - 1];
        const newestArchive = archiveVersions[0];
        if (compareVersions(oldestLive, newestArchive) <= 0) {
            errors.push(`archive starts at ${newestArchive}, which is not older than ${oldestLive}`);
        }
    }
    return errors;
}

function releaseHeading(version, date) {
    return `## [${version}](${SOURCE_RELEASE}${version}) - ${date}`;
}

function main() {
    const root = path.join(__dirname, '..');
    const livePath = path.join(root, 'homeassistant-addon', 'CHANGELOG.md');
    const archivePath = path.join(root, 'homeassistant-addon', 'CHANGELOG-archive.md');
    const live = fs.readFileSync(livePath, 'utf8');
    const archive = fs.readFileSync(archivePath, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const errors = [
        ...validateLiveChangelog(live, { currentVersion: pkg.version })
            .map((error) => `CHANGELOG.md: ${error}`),
        ...validateArchiveChangelog(archive)
            .map((error) => `CHANGELOG-archive.md: ${error}`),
        ...validateChangelogSplit(live, archive)
    ];
    if (errors.length > 0) {
        errors.forEach((error) => {
            console.error(error);
        });
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    MAX_BULLET_WORDS,
    SECTION_ORDER,
    listVersions,
    releaseHeading,
    validateArchiveChangelog,
    validateChangelogSplit,
    validateLiveChangelog
};
