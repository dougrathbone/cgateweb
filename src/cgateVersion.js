// @ts-check
'use strict';

// Older C-Gate answers parameters newer clients rely on with 402. Current
// C-Bus Toolkit, for one, reads OriginateInProject when it opens a network
// and leaves the network Closed on 3.3.2 (#122).
const RECOMMENDED_CGATE_VERSION = '3.8.0';

// "Service ready: Clipsal C-Gate Version: v3.3.2 (build 1855) #cmd-syntax=1.0"
// The vendor prefix changed from Clipsal to Schneider Electric between builds.
const GREETING_VERSION = /C-Gate Version:\s*v?(\d+(?:\.\d+){0,2})(?:\s*\(build\s+(\d+)\))?/i;

/**
 * @param {string|null|undefined} greeting - 201 payload with the code stripped
 * @returns {{version: string, build: string|null}|null}
 */
function parseCgateGreeting(greeting) {
    const match = GREETING_VERSION.exec(String(greeting || ''));
    if (!match) return null;
    return { version: match[1], build: match[2] || null };
}

/** @param {string} version */
function _parts(version) {
    if (!/^\d+(\.\d+){0,2}$/.test(String(version || ''))) return null;
    const parts = String(version).split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts;
}

/**
 * An unparseable version is never "older": warning on a version we cannot
 * read would be a guess.
 * @param {string} version
 * @param {string} minimum
 * @returns {boolean}
 */
function isOlderThan(version, minimum) {
    const a = _parts(version);
    const b = _parts(minimum);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}

/**
 * Logs the C-Gate version from the connection greeting, and warns when it is
 * older than the recommended release. Every pool connection greets on every
 * connect, so each version is reported once.
 */
class CgateVersionReporter {
    /**
     * @param {object} deps
     * @param {Record<string, any>} [deps.settings]
     * @param {{info: Function, warn: Function}} deps.logger
     */
    constructor({ settings, logger }) {
        this.settings = settings || {};
        this.logger = logger;
        /** @type {string|null} */
        this.version = null;
        /** @type {string|null} */
        this.build = null;
    }

    /** @param {string} greeting */
    handleGreeting(greeting) {
        const parsed = parseCgateGreeting(greeting);
        if (!parsed) return;
        if (parsed.version === this.version && parsed.build === this.build) return;
        this.version = parsed.version;
        this.build = parsed.build;

        const build = parsed.build ? ` (build ${parsed.build})` : '';
        this.logger.info(`C-Gate version ${parsed.version}${build}`);

        if (!isOlderThan(parsed.version, RECOMMENDED_CGATE_VERSION)) return;
        const upgrade = String(this.settings.cgate_mode) === 'managed'
            ? `To upgrade, download C-Gate ${RECOMMENDED_CGATE_VERSION} from Clipsal, put the zip in /share/cgate/, `
                + 'leave C-Gate install source unset or set it to upload, and restart the add-on.'
            : `Upgrade C-Gate to ${RECOMMENDED_CGATE_VERSION} or later if something does not work.`;
        this.logger.warn(
            `C-Gate ${parsed.version} is older than ${RECOMMENDED_CGATE_VERSION}; some features may be unsupported. ${upgrade}`
        );
    }
}

module.exports = {
    RECOMMENDED_CGATE_VERSION,
    parseCgateGreeting,
    isOlderThan,
    CgateVersionReporter
};
