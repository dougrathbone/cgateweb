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

// Compare one translation's keys against the source; returns { missing, extra }.
function diffKeys(sourceKeys, keys) {
    return {
        missing: [...sourceKeys].filter((k) => !keys.has(k)),
        extra: [...keys].filter((k) => !sourceKeys.has(k))
    };
}

// docsByName: { 'en.yaml': <doc>, 'de.yaml': <doc>, ... }. Returns error strings.
function validateTranslations(docsByName, sourceName = SOURCE) {
    const sourceKeys = collectKeys(docsByName[sourceName]);
    const errors = [];

    for (const [name, doc] of Object.entries(docsByName)) {
        if (name === sourceName) {
            continue;
        }
        const { missing, extra } = diffKeys(sourceKeys, collectKeys(doc));
        if (missing.length || extra.length) {
            const parts = [];
            if (missing.length) {
                parts.push(`missing ${missing.length} (${missing.join(', ')})`);
            }
            if (extra.length) {
                parts.push(`extra ${extra.length} (${extra.join(', ')})`);
            }
            errors.push(`${name}: ${parts.join('; ')}`);
        }
    }

    return errors;
}

function main() {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml'));
    const docsByName = {};
    for (const file of files) {
        docsByName[file] = YAML.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    }

    const errors = validateTranslations(docsByName);

    if (errors.length > 0) {
        console.error(`Translation key drift against ${SOURCE}:\n`);
        for (const e of errors) {
            console.error(`  - ${e}`);
        }
        console.error(`\nEvery translations/*.yaml must have the same option keys as ${SOURCE}.`);
        process.exit(1);
    }

    console.log(`Translations OK: ${files.length} files, ${collectKeys(docsByName[SOURCE]).size} keys each.`);
}

if (require.main === module) {
    main();
}

module.exports = { collectKeys, diffKeys, validateTranslations };
