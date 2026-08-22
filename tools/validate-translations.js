#!/usr/bin/env node
'use strict';

/**
 * CI guard for homeassistant-addon/translations.
 *
 * catalog.yaml is the source of truth. Locale YAML files are generated from it
 * (npm run generate:translations) and committed for HA Supervisor. This check:
 *   - requires catalog.yaml
 *   - fails if a supported locale is missing from the catalog
 *   - fails if a committed {locale}.yaml is stale vs catalog (diff)
 *   - keeps key-parity of every locale file against en.yaml
 *   - never treats catalog.yaml as a locale file
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const {
    SUPPORTED_LOCALES,
    CATALOG_NAME,
    CATALOG_PATH,
    DIR,
    loadCatalog,
    localesInCatalog,
    generateLocaleYamlMap,
    validateCatalogCompleteness
} = require('./generate-translations');

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

/** Locale yaml basenames only — catalog.yaml is never a locale. */
function listLocaleFiles(dir = DIR) {
    return fs.readdirSync(dir).filter(
        (f) => f.endsWith('.yaml') && f !== CATALOG_NAME
    );
}

/**
 * Compare generated locale YAML to committed files.
 * Returns error strings (empty when in sync).
 */
function validateCatalogFreshness(catalog, dir = DIR) {
    const errors = [];
    const expected = generateLocaleYamlMap(catalog);

    for (const locale of SUPPORTED_LOCALES) {
        const file = `${locale}.yaml`;
        const filePath = path.join(dir, file);
        if (!fs.existsSync(filePath)) {
            errors.push(`${file}: missing on disk (run npm run generate:translations)`);
            continue;
        }
        const committed = fs.readFileSync(filePath, 'utf8');
        const generated = expected[locale];
        if (committed !== generated) {
            errors.push(
                `${file}: stale vs ${CATALOG_NAME} (run npm run generate:translations)`
            );
        }
    }

    // Committed locale files that are not in the supported list.
    for (const file of listLocaleFiles(dir)) {
        const locale = file.replace(/\.yaml$/, '');
        if (!SUPPORTED_LOCALES.includes(locale)) {
            errors.push(`${file}: locale not in supported list`);
        }
    }

    return errors;
}

/** Fail when a supported locale never appears under any catalog string. */
function validateCatalogLocales(catalog) {
    const present = localesInCatalog(catalog);
    return SUPPORTED_LOCALES.filter((l) => !present.has(l)).map(
        (l) => `supported locale "${l}" is missing from ${CATALOG_NAME}`
    );
}

function main() {
    if (!fs.existsSync(CATALOG_PATH)) {
        console.error(`Missing ${CATALOG_NAME} — edit the catalog, then run npm run generate:translations.`);
        process.exit(1);
    }

    const catalog = loadCatalog();
    const errors = [];

    errors.push(...validateCatalogLocales(catalog));
    errors.push(...validateCatalogCompleteness(catalog));
    errors.push(...validateCatalogFreshness(catalog));

    const docsByName = {};
    for (const file of listLocaleFiles()) {
        docsByName[file] = YAML.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    }

    if (!docsByName[SOURCE]) {
        errors.push(`${SOURCE}: missing (required for key-parity check)`);
    } else {
        errors.push(...validateTranslations(docsByName));
    }

    if (errors.length > 0) {
        console.error('Translation validation FAILED:\n');
        for (const e of errors) {
            console.error(`  - ${e}`);
        }
        console.error(
            `\nEdit ${CATALOG_NAME}, then run: npm run generate:translations`
        );
        process.exit(1);
    }

    const keyCount = collectKeys(docsByName[SOURCE]).size;
    console.log(
        `Translations OK: ${CATALOG_NAME} + ${SUPPORTED_LOCALES.length} locales, ` +
        `${keyCount} keys each.`
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    collectKeys,
    diffKeys,
    validateTranslations,
    listLocaleFiles,
    validateCatalogFreshness,
    validateCatalogLocales
};
