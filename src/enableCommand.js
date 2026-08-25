// @ts-check
'use strict';

/**
 * Command builders for C-Gate ENABLE SET|LABEL|REMOVE (Enable Control, $CB).
 *
 * ON/OFF/RAMP already go through the generic lighting-style verbs. These three
 * are the extra Enable Control verbs. LABEL puts the group outside the object
 * path (same shape as lighting LABEL). Labels are always UTF-8 hex so a `#`
 * in the text cannot start a C-Gate comment. REMOVE deletes the C-Gate group
 * object, so the MQTT payload must be ON — a retained empty message must not
 * wipe groups.
 */

const ENABLE_LABEL_LANGUAGE_ENGLISH = 1;
const ENABLE_LABEL_MAX_CHARS = 32;

/**
 * Encode text as space-separated uppercase hex bytes for C-Gate `hex`.
 * @param {string} text
 * @returns {string}
 */
function encodeUtf8ToCgateHex(text) {
    return Buffer.from(text, 'utf8')
        .toString('hex')
        .toUpperCase()
        .replace(/(..)/g, '$1 ')
        .trim();
}

/**
 * @param {unknown} payload
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function parseEnableSetValue(payload) {
    const raw = String(payload ?? '').trim();
    const upper = raw.toUpperCase();
    if (upper === 'ON') {
        return { ok: true, value: 255 };
    }
    if (upper === 'OFF') {
        return { ok: true, value: 0 };
    }
    if (!/^\d+$/.test(raw)) {
        return { ok: false, error: 'expected integer 0–255 or ON/OFF' };
    }
    const n = Number(raw);
    if (n < 0 || n > 255) {
        return { ok: false, error: 'expected integer 0–255 or ON/OFF' };
    }
    return { ok: true, value: n };
}

/**
 * @param {Object} opts
 * @param {string} opts.cbusname
 * @param {string|number} opts.network
 * @param {string|number} opts.application
 * @param {string|number} opts.group
 * @param {unknown} opts.payload
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
function buildEnableSetCommand({ cbusname, network, application, group, payload }) {
    const parsed = parseEnableSetValue(payload);
    if (parsed.ok === false) {
        return { ok: false, error: parsed.error };
    }
    return {
        ok: true,
        command: `enable set //${cbusname}/${network}/${application}/${group} ${parsed.value}`
    };
}

/**
 * @param {Object} opts
 * @param {string} opts.cbusname
 * @param {string|number} opts.network
 * @param {string|number} opts.application
 * @param {string|number} opts.group
 * @param {unknown} opts.payload
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
function buildEnableLabelCommand({ cbusname, network, application, group, payload }) {
    const raw = String(payload ?? '').trim();
    if (!raw) {
        return { ok: false, error: 'label must be non-empty' };
    }
    const clipped = Array.from(raw).slice(0, ENABLE_LABEL_MAX_CHARS).join('');
    const hex = encodeUtf8ToCgateHex(clipped);
    return {
        ok: true,
        command: `enable label //${cbusname}/${network}/${application} ${ENABLE_LABEL_LANGUAGE_ENGLISH} ${group} hex ${hex}`
    };
}

/**
 * @param {Object} opts
 * @param {string} opts.cbusname
 * @param {string|number} opts.network
 * @param {string|number} opts.application
 * @param {string|number} opts.group
 * @param {unknown} opts.payload
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
function buildEnableRemoveCommand({ cbusname, network, application, group, payload }) {
    if (String(payload ?? '').trim().toUpperCase() !== 'ON') {
        return { ok: false, error: 'remove requires payload ON' };
    }
    return {
        ok: true,
        command: `enable remove //${cbusname}/${network}/${application}/${group}`
    };
}

module.exports = {
    buildEnableSetCommand,
    buildEnableLabelCommand,
    buildEnableRemoveCommand,
    encodeUtf8ToCgateHex,
    parseEnableSetValue,
    ENABLE_LABEL_LANGUAGE_ENGLISH,
    ENABLE_LABEL_MAX_CHARS
};
