// @ts-check
'use strict';

const { DEFAULT_CBUS_APP_CLOCK } = require('./constants');

/**
 * Build a `clock request_refresh` command (C-Gate CLOCK REQUEST_REFRESH).
 * Asks the network clock application to rebroadcast date and time. Does not
 * set the clock.
 *
 * @param {Object} opts
 * @param {string} opts.cbusname - C-Gate project name.
 * @param {string|number} opts.network - C-Bus network id.
 * @param {string|number} [opts.application] - Clock application id (default 223).
 * @returns {string}
 */
function buildClockRequestRefresh({ cbusname, network, application = DEFAULT_CBUS_APP_CLOCK }) {
    return `clock request_refresh //${cbusname}/${network}/${application}`;
}

module.exports = { buildClockRequestRefresh };
