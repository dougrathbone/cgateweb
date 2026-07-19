// @ts-check
'use strict';

/**
 * Pure helpers for the optional raw C-Bus event capture feature
 * (settings.cbusRawEventLogApps). Kept out of CgateWebBridge so the bridge
 * only performs the side effects (log + MQTT publish) while the parsing/gating
 * decision is a small, independently testable function.
 */

/**
 * Decide whether a raw C-Gate line should be captured for the configured apps,
 * and extract its address. Returns null when capture is disabled, the line has
 * no network/application/group triple, or the app is not in the capture list.
 *
 * The address is the first numeric triple on the line, which holds for every
 * known C-Gate event/status shape (e.g. "lighting on 254/56/4",
 * "//CLIPSAL/254/56/10", "300 //HOME/254/203/5: level=128").
 *
 * @param {string} line - Raw C-Gate line.
 * @param {Array<string|number>} apps - Configured application IDs to capture.
 * @returns {{network: string, application: string, group: string}|null}
 */
function parseRawCaptureTarget(line, apps) {
    if (!apps || apps.length === 0) {
        return null;
    }
    if (typeof line !== 'string') {
        return null;
    }

    const match = line.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
        return null;
    }

    const application = match[2];
    if (!apps.some((a) => String(a) === application)) {
        return null;
    }

    return { network: match[1], application, group: match[3] };
}

module.exports = { parseRawCaptureTarget };
