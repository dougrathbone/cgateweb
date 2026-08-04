// @ts-check
'use strict';

/**
 * Command builders for the C-Bus Security application (208 / $D0).
 * status_request syncs zone state (read-only); security arm is the only bus
 * write and is gated behind cbus_security_control_enabled — it carries no
 * PIN, so anything able to publish it can arm the panel.
 *
 * Arming only: C-Bus has no disarm command (§5.5.2.3 reserves arm mode $00),
 * and disarming would need §5.5.2.7 Emulate Keypad with the PIN.
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
 * Build a `security arm` command (spec §5.5.2.3). Modes: 1 away, 2 night,
 * 3 day/stay, 4 vacation, $FF highest level of protection.
 *
 * Mode 0 is reserved by the spec and must not be sent — it is not a disarm.
 * Callers are expected to reject DISARM before reaching this builder.
 *
 * @param {Object} opts
 * @param {string} opts.cbusname - C-Gate project name.
 * @param {string|number} opts.network - C-Bus network id.
 * @param {string|number} opts.application - Security application id (e.g. 208).
 * @param {number} opts.mode - Arm mode: 1 away, 2 night, 3 day, 4 vacation.
 * @returns {string}
 */
function buildSecurityArmCommand({ cbusname, network, application, mode }) {
    return `security arm //${cbusname}/${network}/${application} ${mode}`;
}

module.exports = { buildSecurityStatusRequest, buildSecurityArmCommand };
