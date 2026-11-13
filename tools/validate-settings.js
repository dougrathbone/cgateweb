#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Pre-flight check for a standalone settings.js.
 *
 * This replaces an npm script that did `require('./settings.js')` and printed
 * "Settings file is valid!" if it parsed. That proved the file was syntactically
 * JavaScript and nothing more - it happily blessed a config still carrying
 * `cbusip: 'your-cgate-ip'`, which is exactly the config a first-time user has
 * when they most need to be told otherwise.
 *
 * It now runs the same ConfigLoader.validate() the bridge runs at startup, so a
 * pass here means the bridge will get past validation with this file.
 */

const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../src/config/ConfigLoader');
const { defaultSettings } = require('../src/defaultSettings');

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.js');

/**
 * @param {string} [settingsPath] File to check; defaults to the repo-root settings.js.
 * @returns {number} process exit status
 */
function main(settingsPath = SETTINGS_PATH) {
    if (!fs.existsSync(settingsPath)) {
        console.error('No settings.js found.');
        console.error('Create one with:  cp settings.js.example settings.js');
        console.error('Then edit it - docs/SETTINGS.md documents every option.');
        return 1;
    }

    // Pin the loader to the file being checked. Letting EnvironmentDetector
    // search for one would validate whichever settings.js it found first, which
    // need not be the file named here.
    const loader = new ConfigLoader({
        environmentDetector: {
            detect: () => ({
                type: 'standalone',
                isStandalone: true,
                isAddon: false,
                settingsPath,
                workingDirectory: process.cwd()
            })
        }
    });

    let loaded;
    try {
        loaded = loader.load();
    } catch (error) {
        console.error(`settings.js could not be loaded: ${error.message}`);
        return 1;
    }

    // Validate the merged result, because that is what the bridge runs on: a
    // setting the user omitted is not missing, it is whatever defaultSettings
    // says. Validating the raw file alone would report failures the bridge
    // never sees, which is its own kind of lying.
    try {
        loader.validate({ ...defaultSettings, ...loaded });
    } catch (error) {
        // validate() throws with every failure joined into the message, and has
        // already logged them individually.
        console.error(`\nsettings.js is not usable yet: ${error.message}`);
        console.error('docs/SETTINGS.md documents every option.');
        return 1;
    }

    console.log('settings.js is valid - the bridge will start with it.');
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}

module.exports = { main, SETTINGS_PATH };
