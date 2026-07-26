#!/usr/bin/env node
// @ts-check
/**
 * Resolve cgate_serial_device to a live device path (issue #28).
 *
 * A USB PC Interface that is unplugged and replugged can come back as a
 * different ttyUSBn, which made cont-init fail on a path that no longer
 * existed. This records the device's stable identity (the /dev/serial/by-id
 * link name, which encodes vendor, product and serial) on every good boot, and
 * uses it to find the device again after a renumber.
 *
 * Adoption requires an identity match, so an unrelated dongle (Zigbee, Z-Wave)
 * on the same host is never picked up by accident.
 *
 * Usage: cgateweb-resolve-serial.js <configured-device-path>
 * Writes the effective path to CGATEWEB_SERIAL_DEVICE_FILE
 * (default /run/cgateweb/serial-device). Exit 0 on success, 1 when unresolvable.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEVICE_FILE = '/run/cgateweb/serial-device';
const DEFAULT_IDENTITY_FILE = '/data/serial-identity.json';

function byIdDir(devRoot) {
    return path.join(devRoot, 'serial', 'by-id');
}

/**
 * Resolve p to the path it ultimately points at, following symlink chains
 * (needed for /dev/serial/by-id links). Deliberately does not use
 * fs.realpathSync: that canonicalizes every ancestor directory component too,
 * so if /dev (or a test's tmpdir) is itself reached through a symlink — e.g.
 * macOS's /var -> /private/var — the returned path silently changes prefix
 * even though the device path itself was never a symlink. We only want to
 * follow the terminal symlink chain of p, not rewrite its ancestry.
 * @param {string} p
 * @param {number} [depth]
 * @returns {string|null}
 */
function realPathOrNull(p, depth = 0) {
    if (depth > 20) return null; // guard against symlink loops
    let stat;
    try {
        stat = fs.lstatSync(p);
    } catch (e) {
        return null;
    }
    if (!stat.isSymbolicLink()) return path.normalize(p);

    let target;
    try {
        target = fs.readlinkSync(p);
    } catch (e) {
        return null;
    }
    const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(p), target);
    return realPathOrNull(resolved, depth + 1);
}

/**
 * The /dev/serial/by-id link name that resolves to devicePath, or null.
 * @param {string} devicePath
 * @param {{ devRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromByIdDir(devicePath, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    const target = realPathOrNull(devicePath);
    if (!target) return null;

    let entries;
    try {
        entries = fs.readdirSync(byIdDir(devRoot));
    } catch (e) {
        return null; // no udev by-id links on this host
    }

    for (const entry of entries) {
        if (realPathOrNull(path.join(byIdDir(devRoot), entry)) === target) return entry;
    }
    return null;
}

/**
 * Fallback identity for hosts without /dev/serial/by-id: walk up from
 * /sys/class/tty/<name>/device looking for a USB device directory carrying
 * idVendor, idProduct and serial.
 * @param {string} devicePath
 * @param {{ sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromSysfs(devicePath, opts = {}) {
    const sysfsRoot = opts.sysfsRoot || '/sys';
    const name = path.basename(realPathOrNull(devicePath) || devicePath);
    let dir = realPathOrNull(path.join(sysfsRoot, 'class', 'tty', name, 'device'));

    for (let depth = 0; dir && depth < 8; depth++) {
        const parts = ['idVendor', 'idProduct', 'serial'].map(f => {
            try {
                return fs.readFileSync(path.join(dir, f), 'utf8').trim();
            } catch (e) {
                return '';
            }
        });
        if (parts[0] && parts[1]) return parts.join(':');
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Stable identity for a device: by-id link name preferred, sysfs as fallback.
 * @param {string} devicePath
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function readIdentity(devicePath, opts = {}) {
    return identityFromByIdDir(devicePath, opts) || identityFromSysfs(devicePath, opts);
}

/**
 * Live device path for a remembered identity, or null if absent.
 * @param {string} identity
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function findDeviceByIdentity(identity, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    if (!identity) return null;

    // by-id identity: the link itself is the lookup.
    const link = path.join(byIdDir(devRoot), identity);
    const viaLink = realPathOrNull(link);
    if (viaLink) return viaLink;

    // sysfs identity: scan candidate ttys for a matching identity.
    let entries;
    try {
        entries = fs.readdirSync(devRoot);
    } catch (e) {
        return null;
    }
    for (const entry of entries) {
        if (!/^tty(USB|ACM)\d+$/.test(entry)) continue;
        const candidate = path.join(devRoot, entry);
        if (identityFromSysfs(candidate, opts) === identity) return candidate;
    }
    return null;
}

function loadRememberedIdentity(identityFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        return typeof parsed.identity === 'string' ? parsed.identity : null;
    } catch (e) {
        return null;
    }
}

function saveRememberedIdentity(identityFile, identity) {
    try {
        fs.mkdirSync(path.dirname(identityFile), { recursive: true });
        fs.writeFileSync(identityFile, JSON.stringify({ identity }, null, 2));
    } catch (e) {
        // Losing the memo only costs us recovery next boot; never fail startup.
    }
}

/**
 * Whether p resolves to somewhere inside root. configuredPath and devRoot are
 * both meant to describe the same filesystem view (normally /dev); a
 * configuredPath that isn't reachable through the current devRoot refers to a
 * different view (e.g. a stale path from before a container remount) and
 * must not be treated as "present" just because its inode happens to still
 * exist on disk elsewhere.
 * @param {string} p
 * @param {string} root
 * @returns {boolean}
 */
function isWithinRoot(p, root) {
    const relative = path.relative(path.resolve(root), path.resolve(p));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * @param {object} args
 * @param {string} args.configuredPath
 * @param {string} [args.identityFile]
 * @param {string} [args.devRoot]
 * @param {string} [args.sysfsRoot]
 * @returns {{ path: string|null, source: 'configured'|'recovered', identity: string|null, stablePath: string|null, messages: string[] }}
 */
function resolveSerialDevice(args) {
    const { configuredPath } = args;
    const identityFile = args.identityFile || DEFAULT_IDENTITY_FILE;
    const opts = { devRoot: args.devRoot || '/dev', sysfsRoot: args.sysfsRoot || '/sys' };
    const messages = [];

    if (isWithinRoot(configuredPath, opts.devRoot) && fs.existsSync(configuredPath)) {
        const identity = readIdentity(configuredPath, opts);
        if (identity) saveRememberedIdentity(identityFile, identity);
        else messages.push(`No stable identity found for ${configuredPath}; automatic recovery after a replug will not be possible`);

        // Recommend the stable path whenever a raw tty path was configured.
        let stablePath = null;
        const byIdName = identityFromByIdDir(configuredPath, opts);
        if (byIdName) {
            stablePath = path.join(byIdDir(opts.devRoot), byIdName);
            if (path.resolve(configuredPath) !== stablePath) {
                messages.push(`Prefer the stable path: set cgate_serial_device to ${stablePath}`);
            }
        }
        return { path: configuredPath, source: 'configured', identity, stablePath, messages };
    }

    messages.push(`Serial device not found: ${configuredPath}`);
    const remembered = loadRememberedIdentity(identityFile);
    if (!remembered) {
        messages.push('No previously-recorded device identity, so the new path cannot be identified automatically');
        return { path: null, source: 'configured', identity: null, stablePath: null, messages };
    }

    const recovered = findDeviceByIdentity(remembered, opts);
    if (!recovered) {
        messages.push(`Previously-used device (${remembered}) is not present either; is the PC Interface plugged in?`);
        return { path: null, source: 'configured', identity: remembered, stablePath: null, messages };
    }

    const stablePath = path.join(byIdDir(opts.devRoot), remembered);
    messages.push(`Recovered: the previously-used device is now at ${recovered} — adopting it for this boot`);
    messages.push(`Update cgate_serial_device to ${stablePath} so this survives future replugs`);
    return { path: recovered, source: 'recovered', identity: remembered, stablePath, messages };
}

function main() {
    const configuredPath = process.argv[2];
    if (!configuredPath) {
        console.error('usage: cgateweb-resolve-serial.js <configured-device-path>');
        process.exit(1);
    }

    const result = resolveSerialDevice({
        configuredPath,
        identityFile: process.env.CGATEWEB_SERIAL_IDENTITY_FILE || DEFAULT_IDENTITY_FILE
    });
    for (const message of result.messages) console.error(message);

    if (!result.path) process.exit(1);

    const deviceFile = process.env.CGATEWEB_SERIAL_DEVICE_FILE || DEFAULT_DEVICE_FILE;
    try {
        fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
        fs.writeFileSync(deviceFile, result.path);
    } catch (e) {
        console.error(`Could not write ${deviceFile}: ${e.message}`);
        process.exit(1);
    }
    console.log(result.path);
}

if (require.main === module) main();

module.exports = {
    identityFromByIdDir,
    identityFromSysfs,
    readIdentity,
    findDeviceByIdentity,
    resolveSerialDevice
};
