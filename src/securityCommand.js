// @ts-check
'use strict';

/**
 * Command builders for the C-Bus Security application (208 / $D0).
 * Phase 1 is read-only on the bus: the only command is the status request
 * used for initial zone-state sync (spec §5.5.2.1-2). Arm/disarm writes are
 * phase 2 (see docs/SECURITY_INVESTIGATION.md §5).
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

module.exports = { buildSecurityStatusRequest };
