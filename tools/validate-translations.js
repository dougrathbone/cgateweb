#!/usr/bin/env node
'use strict';

/**
 * CI guard for homeassistant-addon/translations/*.yaml.
 *
 * en.yaml is the source of truth. Every other translation file must contain
 * exactly the same set of option keys (the children of each top-level section,
 * e.g. "configuration.cgate_mode"). This prevents the documented 17-language
 * drift where a new or renamed config option is left untranslated in some
 * languages. The translated name/description text itself is not compared.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DIR = path.join(__dirname, '..', 'homeassistant-addon', 'translations');
const SOURCE = 'en.yaml';

// Collect "section.childKey" for every child of every top-level section.
function collectKeys(doc) {
    const keys = new Set();
    for (const [section, value] of Object.entries(doc || {})) {
        if (value && typeof value === 'object') {
            for (const childKey of Object.keys(value)) {
                keys.add(`${section}.${childKey}`);
            }
        } else {
            keys.add(section);
        }
    }
    return keys;
}

function main() {
    const sourceKeys = collectKeys(YAML.parse(fs.readFileSync(path.join(DIR, SOURCE), 'utf8')));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml') && f !== SOURCE);
    const errors = [];

    for (const file of files) {
        const keys = collectKeys(YAML.parse(fs.readFileSync(path.join(DIR, file), 'utf8')));
        const missing = [...sourceKeys].filter((k) => !keys.has(k));
        const extra = [...keys].filter((k) => !sourceKeys.has(k));

        if (missing.length || extra.length) {
            const parts = [];
            if (missing.length) {
                parts.push(`missing ${missing.length} (${missing.join(', ')})`);
            }
            if (extra.length) {
                parts.push(`extra ${extra.length} (${extra.join(', ')})`);
            }
            errors.push(`${file}: ${parts.join('; ')}`);
        }
    }

    if (errors.length > 0) {
        console.error(`Translation key drift against ${SOURCE}:\n`);
        for (const e of errors) {
            console.error(`  - ${e}`);
        }
        console.error(`\nEvery translations/*.yaml must have the same option keys as ${SOURCE}.`);
        process.exit(1);
    }

    console.log(`Translations OK: ${files.length + 1} files, ${sourceKeys.size} keys each.`);
}

main();
