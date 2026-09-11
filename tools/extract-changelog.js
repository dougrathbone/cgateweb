#!/usr/bin/env node
'use strict';

/**
 * Print the CHANGELOG section for one version (for GitHub Release bodies).
 *
 * Usage:
 *   node tools/extract-changelog.js 1.27.0
 *   node tools/extract-changelog.js --insert 1.27.1 2026-09-11
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} markdown
 * @param {string} version
 * @returns {string}
 */
function extractChangelogSection(markdown, version) {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`extract-changelog: invalid version "${version}"`);
    }
    const prefix = `## [${version}]`;
    const lines = markdown.split(/\n/);
    const start = lines.findIndex((line) => line.startsWith(prefix));
    if (start === -1) {
        throw new Error(`extract-changelog: no CHANGELOG section for ${version}`);
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## [')) {
            end = i;
            break;
        }
    }
    return `${lines.slice(start, end).join('\n').trim()}\n`;
}

/**
 * Insert a new version heading above the current top section.
 * Never replaces an existing heading — that is how 1.34.8 and 1.34.7
 * notes were swallowed into the next release.
 *
 * @param {string} markdown
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @returns {string}
 */
function insertChangelogVersion(markdown, version, date) {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`extract-changelog: invalid version "${version}"`);
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`extract-changelog: invalid date "${date}"`);
    }
    if (markdown.includes(`## [${version}]`)) {
        throw new Error(`extract-changelog: CHANGELOG already has ${version}`);
    }
    const firstHeading = markdown.search(/^## \[/m);
    if (firstHeading === -1) {
        throw new Error('extract-changelog: no existing version heading to insert above');
    }
    return `${markdown.slice(0, firstHeading)}## [${version}] - ${date}\n\n${markdown.slice(firstHeading)}`;
}

function main() {
    if (process.argv[2] === '--insert') {
        const version = process.argv[3];
        const date = process.argv[4];
        const changelogPath = process.argv[5]
            || path.join(__dirname, '..', 'homeassistant-addon', 'CHANGELOG.md');
        const markdown = fs.readFileSync(changelogPath, 'utf8');
        fs.writeFileSync(changelogPath, insertChangelogVersion(markdown, version, date));
        return;
    }
    const version = process.argv[2];
    const changelogPath = process.argv[3]
        || path.join(__dirname, '..', 'homeassistant-addon', 'CHANGELOG.md');
    const markdown = fs.readFileSync(changelogPath, 'utf8');
    process.stdout.write(extractChangelogSection(markdown, version));
}

if (require.main === module) {
    main();
}

module.exports = { extractChangelogSection, insertChangelogVersion };
