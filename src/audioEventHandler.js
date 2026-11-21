// @ts-check
'use strict';

const { isAppEventLine } = require('./applicationDecoders/appEventLine');

/**
 * Claims C-Bus Audio ($CD / app 205) and Media Transport Control ($C0 /
 * app 192) event lines.
 *
 * Neither application is decoded yet. The C-Gate manual documents the command
 * names and argument ranges (sections 4.5.16-4.5.35 and 4.5.99-4.5.118) but
 * not what the zone function codes mean, and there are no real captures in
 * this repository, so writing a decoder now would be a guess (see the note in
 * src/applicationDecoders/clockDecoder.js on why that is worse than a missing
 * feature; docs/AUDIO_INVESTIGATION.md lists what is unknown). What this handler does instead:
 *
 *  - Keeps the lines out of CBusEvent. Their address has two segments
 *    (`//PROJECT/<net>/<app>`, no group), so CBusEvent warns "Could not parse
 *    event line" on every one, and the `#`/`#s#`-prefixed form is dropped as a
 *    comment before anything else sees it.
 *  - Sends them to raw event capture, so a tester can set
 *    cbus_raw_event_log_apps to 205 and 192 and share what their hardware
 *    actually emits.
 *  - Says once, at INFO, that audio traffic is on the bus and how to capture
 *    it.
 */

const AUDIO_APP_ID = '205';
const MEDIA_TRANSPORT_APP_ID = '192';

/** @type {Array<{ prefix: 'audio'|'mediatransport', name: string, appId: string }>} */
const CLAIMED_APPLICATIONS = [
    { prefix: 'audio', name: 'Audio', appId: AUDIO_APP_ID },
    { prefix: 'mediatransport', name: 'Media Transport', appId: MEDIA_TRANSPORT_APP_ID }
];

class AudioEventHandler {
    /**
     * @param {Object} deps
     * @param {{ info: Function, debug: Function }} deps.logger
     * @param {(line: string) => void} deps.captureRaw - Raw event capture hook.
     */
    constructor({ logger, captureRaw }) {
        this.logger = logger;
        this.captureRaw = captureRaw;
        /** @type {Set<string>} */
        this._hintedApps = new Set();
    }

    /**
     * @param {string} line - Raw line from the C-Gate event stream.
     * @returns {true|false} true when the line was audio or media transport
     *   traffic and has been consumed, false when it is neither.
     */
    handleLine(line) {
        const application = CLAIMED_APPLICATIONS.find((app) => isAppEventLine(line, app.prefix));
        if (!application) return false;

        this.captureRaw(line);
        this._hintOnce(application);
        return true;
    }

    /**
     * Once per application, not once per line: an audio matrix reports every
     * zone change and this is INFO.
     * @param {{ name: string, appId: string }} application
     * @private
     */
    _hintOnce(application) {
        if (this._hintedApps.has(application.appId)) return;
        this._hintedApps.add(application.appId);
        this.logger.info(
            `C-Bus ${application.name} traffic seen but not decoded yet. To help add support, set `
            + `cbus_raw_event_log_apps to include ${application.appId} and share the captured lines `
            + `(https://github.com/dougrathbone/cgateweb/issues/172).`
        );
    }
}

module.exports = AudioEventHandler;
