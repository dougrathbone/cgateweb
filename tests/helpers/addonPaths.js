'use strict';

const path = require('path');

// Every add-on shell/script test points at a file under
// homeassistant-addon/rootfs, and each was spelling out the same six-segment
// path.join from tests/ - often across several lines. That is fine until the
// add-on layout moves, at which point it is twenty edits in eight files with
// no single place to look.
const ROOTFS = path.join(__dirname, '..', '..', 'homeassistant-addon', 'rootfs');

/**
 * Absolute path to a file in the add-on rootfs, from repo-relative segments.
 *
 * @param {...string} segments - Path under homeassistant-addon/rootfs.
 * @returns {string}
 */
function addonPath(...segments) {
    return path.join(ROOTFS, ...segments);
}

/** A script in rootfs/usr/bin (the add-on's user-facing commands). */
const addonBin = (name) => addonPath('usr', 'bin', name);

/** A sourced library in rootfs/usr/lib/cgateweb (shared shell helpers). */
const addonLib = (name) => addonPath('usr', 'lib', 'cgateweb', name);

/** A startup script in rootfs/etc/cont-init.d (s6 container init). */
const addonInit = (name) => addonPath('etc', 'cont-init.d', name);

module.exports = { ROOTFS, addonPath, addonBin, addonLib, addonInit };
