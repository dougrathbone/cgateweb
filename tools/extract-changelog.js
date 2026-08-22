#!/usr/bin/env node
'use strict';

/**
 * Print the CHANGELOG section for one version (for GitHub Release bodies).
 *
 * Usage: node tools/extract-changelog.js 1.27.0
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

function main() {
    const version = process.argv[2];
    const changelogPath = process.argv[3]
        || path.join(__dirname, '..', 'homeassistant-addon', 'CHANGELOG.md');
    const markdown = fs.readFileSync(changelogPath, 'utf8');
    process.stdout.write(extractChangelogSection(markdown, version));
}

if (require.main === module) {
    main();
}

module.exports = { extractChangelogSection };
