// @ts-check
'use strict';

/**
 * Command builders for the C-Bus Security application (208 / $D0).
 * status_request syncs zone state (read-only); security arm is the only bus
 * write and is gated behind cbus_security_control_enabled — it carries no
 * PIN, so anything able to publish it can arm the panel.
 *
 * Arming only: C-Gate offers no disarm arm-mode, and disarming would need
 * SECURITY EMULATE_KEYPAD with the PIN (#51).
 *
 * Note these builders target the **C-Gate command interface**, so they use
 * C-Gate's syntax and keywords (manual §4.5.176-182) rather than the numeric
 * encodings in the C-Bus Security application spec. The two differ, and
 * assuming otherwise is what broke arming in 1.23.0 (#42).
 */

/**
 * Build a `security status_request` command. Report 1 returns the system arm
 * state, tamper and panic plus zones 1-32; report 2 returns zones 33-80.
 * Security panels do not answer lighting-style getall requests (spec §5.9),
 * so both reports are requested on connect and on first security traffic.
 *
 * @param {Object} opts
 * @param {string} opts.cbusname - C-Gate project name.
 * @param {string|number} opts.network - C-Bus network id.
 * @param {string|number} opts.application - Security application id (e.g. 208).
 * @param {number} opts.report - Report number: 1 or 2.
 * @returns {string}
 */
function buildSecurityStatusRequest({ cbusname, network, application, report }) {
    return `security status_request //${cbusname}/${network}/${application} ${report}`;
}

/**
 * Build a `security arm` command (C-Gate manual §4.5.177).
 *
 * `mode` must be one of C-Gate's arm-mode keywords — `away`, `night` (home),
 * `day`, `vacation` or `highest`. Anything else, including the application
 * spec's numeric mode values, is rejected with
 * `405 Parameter out of range (bad arm mode)`.
 *
 * There is no disarm keyword; callers reject DISARM before reaching here.
 *
 * @param {Object} opts
 * @param {string} opts.cbusname - C-Gate project name.
 * @param {string|number} opts.network - C-Bus network id.
 * @param {string|number} opts.application - Security application id (e.g. 208).
 * @param {string} opts.mode - C-Gate arm-mode keyword.
 * @returns {string}
 */
function buildSecurityArmCommand({ cbusname, network, application, mode }) {
    return `security arm //${cbusname}/${network}/${application} ${mode}`;
}

module.exports = { buildSecurityStatusRequest, buildSecurityArmCommand };
