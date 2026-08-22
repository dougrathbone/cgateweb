#!/usr/bin/env node
'use strict';

/**
 * Generate homeassistant-addon/translations/{locale}.yaml from catalog.yaml.
 *
 * Edit catalog.yaml (section → option → name|description → locale), then run:
 *   npm run generate:translations
 *
 * Generated locale files are committed so HA Supervisor / distribution copy
 * work without an extra build step.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DIR = path.join(__dirname, '..', 'homeassistant-addon', 'translations');
const CATALOG_NAME = 'catalog.yaml';
const CATALOG_PATH = path.join(DIR, CATALOG_NAME);

/** Home Assistant add-on UI locales (must stay in sync with validate-translations). */
const SUPPORTED_LOCALES = Object.freeze([
    'en', 'de', 'es', 'fr', 'it', 'nl', 'pt', 'ru', 'zh',
    'ja', 'ko', 'pl', 'sv', 'no', 'da', 'cs', 'uk'
]);

function loadCatalog(catalogPath = CATALOG_PATH) {
    if (!fs.existsSync(catalogPath)) {
        throw new Error(`Missing translation catalog: ${catalogPath}`);
    }
    return YAML.parse(fs.readFileSync(catalogPath, 'utf8'));
}

/** Collect every locale code present under any name/description map. */
function localesInCatalog(catalog) {
    const locales = new Set();
    for (const section of Object.values(catalog || {})) {
        if (!section || typeof section !== 'object') {
            continue;
        }
        for (const option of Object.values(section)) {
            if (!option || typeof option !== 'object') {
                continue;
            }
            for (const field of ['name', 'description']) {
                const byLocale = option[field];
                if (byLocale && typeof byLocale === 'object') {
                    for (const locale of Object.keys(byLocale)) {
                        locales.add(locale);
                    }
                }
            }
        }
    }
    return locales;
}

/** Build the HA per-locale document (section → option → name/description). */
function buildLocaleDoc(catalog, locale) {
    const doc = {};
    for (const [section, options] of Object.entries(catalog || {})) {
        if (!options || typeof options !== 'object') {
            continue;
        }
        const sectionOut = {};
        for (const [optionKey, fields] of Object.entries(options)) {
            if (!fields || typeof fields !== 'object') {
                continue;
            }
            const entry = {};
            if (fields.name && fields.name[locale] !== undefined && fields.name[locale] !== null) {
                entry.name = fields.name[locale];
            }
            if (fields.description && fields.description[locale] !== undefined && fields.description[locale] !== null) {
                entry.description = fields.description[locale];
            }
            if (Object.keys(entry).length > 0) {
                sectionOut[optionKey] = entry;
            }
        }
        if (Object.keys(sectionOut).length > 0) {
            doc[section] = sectionOut;
        }
    }
    return doc;
}

function foldedScalar(value) {
    const scalar = new YAML.Scalar(value);
    // Match the existing locale style: folded block with strip chomping (>-).
    scalar.type = 'BLOCK_FOLDED';
    return scalar;
}

/** Serialize one locale document in the committed HA translations format. */
function stringifyLocaleDoc(doc) {
    const root = new YAML.YAMLMap();

    for (const [section, options] of Object.entries(doc || {})) {
        const sectionMap = new YAML.YAMLMap();
        for (const [optionKey, fields] of Object.entries(options || {})) {
            const optionMap = new YAML.YAMLMap();
            if (fields.name !== undefined && fields.name !== null) {
                optionMap.set('name', fields.name);
            }
            if (fields.description !== undefined && fields.description !== null) {
                const text = String(fields.description);
                optionMap.set(
                    'description',
                    text.includes('\n') || text.length > 80 ? foldedScalar(text) : text
                );
            }
            sectionMap.set(optionKey, optionMap);
        }
        root.set(section, sectionMap);
    }

    const document = new YAML.Document();
    document.contents = root;
    return String(document);
}

/**
 * Every option must have a non-empty name and description for every supported locale.
 * @param {Object} catalog
 * @returns {string[]}
 */
function validateCatalogCompleteness(catalog) {
    const errors = [];
    for (const [section, options] of Object.entries(catalog || {})) {
        if (!options || typeof options !== 'object') {
            continue;
        }
        for (const [optionKey, fields] of Object.entries(options)) {
            if (!fields || typeof fields !== 'object') {
                errors.push(`${section}.${optionKey}: expected name and description maps`);
                continue;
            }
            for (const field of ['name', 'description']) {
                const byLocale = fields[field];
                if (!byLocale || typeof byLocale !== 'object') {
                    errors.push(`${section}.${optionKey}.${field}: missing locale map`);
                    continue;
                }
                for (const locale of SUPPORTED_LOCALES) {
                    const text = byLocale[locale];
                    if (typeof text !== 'string' || text.trim() === '') {
                        errors.push(`${section}.${optionKey}.${field}.${locale}: missing`);
                    }
                }
            }
        }
    }
    return errors;
}

/**
 * Generate YAML text for every supported locale.
 * @returns {{ [locale: string]: string }}
 */
function generateLocaleYamlMap(catalog = loadCatalog()) {
    const out = {};
    for (const locale of SUPPORTED_LOCALES) {
        out[locale] = stringifyLocaleDoc(buildLocaleDoc(catalog, locale));
    }
    return out;
}

function writeGeneratedLocales(catalog = loadCatalog(), dir = DIR) {
    const byLocale = generateLocaleYamlMap(catalog);
    for (const [locale, yamlText] of Object.entries(byLocale)) {
        fs.writeFileSync(path.join(dir, `${locale}.yaml`), yamlText, 'utf8');
    }
    return byLocale;
}

function main() {
    const catalog = loadCatalog();
    const present = localesInCatalog(catalog);
    const missingLocales = SUPPORTED_LOCALES.filter((l) => !present.has(l));
    if (missingLocales.length > 0) {
        console.error(
            `catalog.yaml is missing supported locale(s): ${missingLocales.join(', ')}`
        );
        process.exit(1);
    }

    const byLocale = writeGeneratedLocales(catalog);
    console.log(
        `Generated ${Object.keys(byLocale).length} locale files from ${CATALOG_NAME}.`
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    SUPPORTED_LOCALES,
    CATALOG_NAME,
    CATALOG_PATH,
    DIR,
    loadCatalog,
    localesInCatalog,
    buildLocaleDoc,
    stringifyLocaleDoc,
    generateLocaleYamlMap,
    writeGeneratedLocales,
    validateCatalogCompleteness
};
