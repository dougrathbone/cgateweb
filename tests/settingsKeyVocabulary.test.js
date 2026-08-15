const fs = require('fs');
const path = require('path');

const { listKnownConfigKeys, buildDefaults } = require('../src/config/schema');

const SRC_DIR = path.join(__dirname, '..', 'src');
const CONFIG_DIR = path.join(SRC_DIR, 'config');

/**
 * Keys a settings read may legitimately use that are NOT part of the declared
 * vocabulary in src/config/schema.js.
 *
 * KEEP THIS EMPTY IF AT ALL POSSIBLE. Every entry here is a setting the code
 * reads that nothing declares, which is exactly the state this test exists to
 * prevent: ConfigLoader derives its known-key vocabulary from the schema, so an
 * undeclared key is one that a user setting it would be told is a typo that
 * "will be ignored by defaults" — untrue on both counts. The fix is almost
 * always to add the setting to SETTINGS_SCHEMA (or, if it has no default and is
 * set by the loader itself, to INTERNAL_CONFIG_KEYS), not to add it here.
 *
 * @type {string[]}
 */
const ALLOWLIST = [];

/**
 * Tokens that look like a settings read but are the filename `settings.js`
 * (and friends) appearing in a comment, a string or a require path.
 */
const FILE_EXTENSION_TOKENS = new Set(['js', 'json', 'yaml', 'yml', 'example', 'bak']);

// `settings` is the settings object everywhere in the codebase; `config` is
// only the settings object inside src/config, where ConfigLoader assembles it.
// Elsewhere a variable called `config` is something else entirely (in
// haDiscoveryPublishers it is a discovery-type descriptor), so scanning it
// there would produce nothing but noise. The "config is only settings inside
// src/config" assumption is itself asserted below, so it cannot quietly rot.
const SETTINGS_READ = /(?:^|[^A-Za-z0-9_$])settings\.([A-Za-z_][A-Za-z0-9_]*)/g;
const CONFIG_READ = /(?:^|[^A-Za-z0-9_$])config\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** @returns {string[]} every .js file under src/, absolute, sorted */
function listSourceFiles(dir = SRC_DIR) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    /** @type {string[]} */
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

/**
 * Every `settings.<key>` (and, inside src/config, `config.<key>`) read in src/.
 * @param {(key: string) => boolean} keep - which keys to report
 * @returns {{ key: string, location: string }[]}
 */
function findSettingsReads(keep) {
    /** @type {{ key: string, location: string }[]} */
    const reads = [];
    for (const file of listSourceFiles()) {
        const patterns = file.startsWith(CONFIG_DIR + path.sep)
            ? [SETTINGS_READ, CONFIG_READ]
            : [SETTINGS_READ];
        const relative = path.relative(path.join(__dirname, '..'), file);
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            for (const pattern of patterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(line)) !== null) {
                    const key = match[1];
                    if (FILE_EXTENSION_TOKENS.has(key)) continue;
                    if (!keep(key)) continue;
                    reads.push({ key, location: `${relative}:${index + 1}` });
                }
            }
        });
    }
    return reads;
}

describe('settings reads in src/ against the declared vocabulary', () => {
    const known = listKnownConfigKeys();

    it('reads no setting that the schema does not declare', () => {
        // This is the structural half of the false-typo fix. ConfigLoader's
        // known-key set is derived from the schema, so any key read here but
        // absent there would be reported to the user as a typo that will be
        // ignored — the bug that hit getall_networks,
        // ha_discovery_security_device_class_keywords and cgate_download_url
        // in turn, each time found only after a user tripped over it.
        const undeclared = findSettingsReads(
            (key) => !known.has(key) && !ALLOWLIST.includes(key)
        );

        expect(undeclared.map((read) => `${read.key} (${read.location})`)).toEqual([]);
    });

    it('keeps the allowlist small enough that it cannot hide a drift', () => {
        // A large allowlist would defeat the test above. If this ever needs
        // raising, the right answer is almost certainly a schema entry.
        expect(ALLOWLIST.length).toBeLessThanOrEqual(3);
    });

    it('allowlists nothing that the schema already declares', () => {
        expect(ALLOWLIST.filter((key) => known.has(key))).toEqual([]);
    });

    it('finds real settings reads, so a broken scanner cannot pass vacuously', () => {
        // Guards the regexes themselves: if they stopped matching, the test
        // above would pass by finding nothing at all.
        const declaredReads = findSettingsReads((key) => known.has(key));
        expect(declaredReads.length).toBeGreaterThan(100);

        const keysRead = new Set(declaredReads.map((read) => read.key));
        expect(keysRead.has('cbusip')).toBe(true);
        expect(keysRead.has('ha_discovery_enabled')).toBe(true);
    });

    it('confines `config`-as-settings to src/config, as the scanner assumes', () => {
        // The scanner only treats `config.<key>` as a settings read inside
        // src/config. If another module starts using a variable called
        // `config` to hold settings, that assumption is wrong and the scanner
        // would stop seeing its reads — so fail here and widen the scan.
        const settingKeys = new Set(Object.keys(buildDefaults()));
        const strays = [];
        for (const file of listSourceFiles()) {
            if (file.startsWith(CONFIG_DIR + path.sep)) continue;
            const relative = path.relative(path.join(__dirname, '..'), file);
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
                CONFIG_READ.lastIndex = 0;
                let match;
                while ((match = CONFIG_READ.exec(line)) !== null) {
                    if (settingKeys.has(match[1])) {
                        strays.push(`${match[1]} (${relative}:${index + 1})`);
                    }
                }
            });
        }
        expect(strays).toEqual([]);
    });
});
