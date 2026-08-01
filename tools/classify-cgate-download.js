#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Classify the result of fetching the C-Gate package from Schneider.
 *
 * Why this exists: CI could not tell three very different outcomes apart, and
 * failed identically for all of them.
 *
 *   1. Schneider's identity provider throttling GitHub's shared runner egress
 *      IPs. It answers HTTP 200 with an HTML page saying "The rate limit for
 *      endpoint /u/login/identifier was reached". Nothing is wrong with the
 *      package, the pin, or this repo, and real users downloading from their
 *      own IPs are unaffected. Observed on 2026-07-29 and 2026-07-31; the same
 *      URLs served a valid zip from a developer machine at the same time.
 *   2. Schneider moving or withdrawing the file. Fresh installs break for
 *      users. Must fail loudly.
 *   3. Schneider repackaging the zip so the pinned checksum no longer matches
 *      (this happened on 2026-07-24 and broke every fresh install). Must fail
 *      loudly.
 *
 * Conflating (1) with (2) and (3) made a required status check hostage to a
 * third party's rate limiter, blocking every PR merge, while also burying the
 * signal that would tell us (2) or (3) had actually happened.
 *
 * Deliberately narrow: only the specific, evidenced rate-limit signature is
 * treated as throttling. Any other HTML response is 'moved', because treating
 * all HTML as throttling would let a genuine portal move sail through green.
 */

/** Schneider's identity provider host; a redirect here means we were bounced to auth. */
const IDP_HOST = 'idp.se.com';

/** The rate-limit wording, as it appears both in the redirect URL and the page. */
const RATE_LIMIT_MARKER = /rate limit/i;

/**
 * @typedef {Object} DownloadObservation
 * @property {number} httpStatus - curl's %{http_code} (0 when the transfer failed outright)
 * @property {string} finalUrl - curl's %{url_effective}, after redirects
 * @property {string} contentType - curl's %{content_type}
 * @property {string} bodySample - first bytes of the payload
 * @property {number} [curlExitCode] - non-zero when curl itself failed
 * @property {string} [expectedSha256] - pinned checksum; omit to skip the check
 * @property {string} [actualSha256] - checksum of what we received
 *
 * @typedef {Object} DownloadClassification
 * @property {'ok'|'rate-limited'|'moved'|'corrupt'|'unavailable'} classification
 * @property {string} reason - human-readable, safe to put in a CI annotation
 * @property {boolean} retryable - whether another attempt could plausibly succeed
 */

/**
 * @param {DownloadObservation} observation
 * @returns {DownloadClassification}
 */
function classifyCgateDownload(observation) {
    const {
        httpStatus = 0,
        finalUrl = '',
        contentType = '',
        bodySample = '',
        curlExitCode = 0,
        expectedSha256,
        actualSha256
    } = observation || {};

    if (curlExitCode) {
        return {
            classification: 'unavailable',
            reason: `transfer failed (curl exit ${curlExitCode})`,
            retryable: true
        };
    }

    // Check throttling before the status code: the giveaway is that Schneider
    // returns 200 with an HTML body, so a status-first check would miss it.
    const bouncedToIdp = finalUrl.includes(IDP_HOST);
    const saysRateLimited = RATE_LIMIT_MARKER.test(finalUrl) || RATE_LIMIT_MARKER.test(bodySample);
    if (bouncedToIdp || saysRateLimited) {
        return {
            classification: 'rate-limited',
            reason: 'Schneider rate-limited this runner (redirected to the identity provider '
                + 'instead of serving the zip). Not a package or pin problem.',
            retryable: true
        };
    }

    if (httpStatus >= 500) {
        return {
            classification: 'unavailable',
            reason: `Schneider returned HTTP ${httpStatus}`,
            retryable: true
        };
    }

    if (httpStatus === 404 || httpStatus === 410) {
        return {
            classification: 'moved',
            reason: `Schneider returned HTTP ${httpStatus} — the file has moved or been withdrawn`,
            retryable: false
        };
    }

    // A real zip starts with PK. Anything else at this point is a web page we
    // do not recognise, which is a genuine portal change rather than throttling.
    if (!bodySample.startsWith('PK')) {
        const firstBytes = bodySample.slice(0, 120).replace(/\s+/g, ' ').trim();
        return {
            classification: 'moved',
            reason: `response is not a zip (content-type "${contentType}", starts with "${firstBytes}") `
                + 'and does not match the known rate-limit page — Schneider may have changed the portal',
            retryable: false
        };
    }

    if (expectedSha256 && actualSha256 && expectedSha256 !== actualSha256) {
        return {
            classification: 'corrupt',
            reason: `checksum mismatch (expected ${expectedSha256}, got ${actualSha256}) — `
                + 'Schneider likely repackaged the zip; verify it is genuinely theirs, then re-pin',
            retryable: false
        };
    }

    return { classification: 'ok', reason: 'zip magic and checksum match the pin', retryable: false };
}

/**
 * Make a reason string safe to echo into a CI annotation. The reason can embed
 * bytes Schneider sent us, so it must not be able to inject workflow commands
 * (`::error::`), break out onto new lines, or run to arbitrary length.
 *
 * @param {string} reason
 * @returns {string}
 */
function sanitizeReason(reason) {
    return String(reason)
        .replace(/[\r\n]+/g, ' ')
        .replace(/::/g, ':')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 300)
        .trim();
}

module.exports = { classifyCgateDownload, sanitizeReason };

// CLI: reads the observation from the environment (so nothing lands in a
// rendered command line) and writes key=value pairs to $GITHUB_OUTPUT.
if (require.main === module) {
    const fs = require('fs');
    const bodyFile = process.env.BODY_FILE;
    let bodySample = '';
    if (bodyFile && fs.existsSync(bodyFile)) {
        const fd = fs.openSync(bodyFile, 'r');
        const buffer = Buffer.alloc(512);
        const bytes = fs.readSync(fd, buffer, 0, 512, 0);
        fs.closeSync(fd);
        bodySample = buffer.subarray(0, bytes).toString('latin1');
    }

    const result = classifyCgateDownload({
        httpStatus: Number(process.env.HTTP_STATUS || 0),
        finalUrl: process.env.FINAL_URL || '',
        contentType: process.env.CONTENT_TYPE || '',
        bodySample,
        curlExitCode: Number(process.env.CURL_EXIT || 0),
        expectedSha256: process.env.EXPECTED_SHA256 || undefined,
        actualSha256: process.env.ACTUAL_SHA256 || undefined
    });

    const reason = sanitizeReason(result.reason);
    process.stdout.write(`classification: ${result.classification}\nreason: ${reason}\n`);

    // Written as separate files rather than shell-eval'd key=value pairs: the
    // reason can embed bytes Schneider sent us, and eval'ing that in the
    // workflow would be a shell injection with a network-controlled payload.
    // The classification is a fixed enum, so it is safe to branch on directly.
    const outDir = process.env.CLASSIFY_OUT_DIR;
    if (outDir) {
        fs.writeFileSync(`${outDir}/classification`, result.classification);
        fs.writeFileSync(`${outDir}/reason`, reason);
    }
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `classification=${result.classification}\nreason=${reason}\nretryable=${result.retryable}\n`
        );
    }
}
