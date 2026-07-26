#!/usr/bin/env node
// @ts-check
/**
 * Resolve cgate_serial_device to a live device path (issue #28).
 *
 * A USB PC Interface that is unplugged and replugged can come back as a
 * different ttyUSBn, which made cont-init fail on a path that no longer
 * existed. This records the device's stable identity (see below for what
 * "stable" means) on every good boot, and uses it to find the device again
 * after a renumber.
 *
 * Adoption requires an identity match: the /dev/serial/by-id link name when
 * udev provides one, or a vendor:product:serial triple read from sysfs when it
 * does not. The sysfs fallback deliberately requires a serial number — many
 * Zigbee/Z-Wave sticks share the FTDI/CH340/CP2102 vendor:product pairs a
 * C-Bus interface uses, so vendor:product alone would be enough to adopt the
 * wrong device — and a device with no serial number gets no sysfs identity at
 * all (see identityFromSysfs).
 *
 * The by-id link name is a weaker guarantee: it is whatever udev's ID_SERIAL
 * populates, which for a serial-less device collapses to just Vendor_Model.
 * Two identical serial-less sticks of the same model then share the same
 * by-id name — the OS cannot tell them apart either, so this is not something
 * the resolver can fix.
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

const TTY_NAME = /^tty(USB|ACM)\d+$/;

/**
 * Follow the terminal symlink chain of p within /dev, without canonicalizing
 * p's ancestor directories. Used purely to compare two /dev paths for
 * identity: a /dev/serial/by-id link and the tty it points at are both under
 * the same devRoot, so ancestry never needs rewriting, and leaving it alone
 * keeps the comparison stable when /dev itself is reached through a symlink
 * (e.g. macOS's /var -> /private/var under a test tmpdir).
 *
 * Not suitable for sysfs, where ancestor components are themselves symlinks
 * and link targets are relative to the canonical ancestry — use
 * canonicalPathOrNull there.
 * @param {string} p
 * @param {number} [depth]
 * @returns {string|null}
 */
function lexicalRealPathOrNull(p, depth = 0) {
    if (depth > 20) return null; // guard against symlink loops
    let stat;
    try {
        stat = fs.lstatSync(p);
    } catch {
        return null;
    }
    if (!stat.isSymbolicLink()) return path.normalize(p);

    let target;
    try {
        target = fs.readlinkSync(p);
    } catch {
        return null;
    }
    const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(p), target);
    return lexicalRealPathOrNull(resolved, depth + 1);
}

/**
 * Fully canonical path (every ancestor component resolved), or null if p does
 * not exist. Required for sysfs: /sys/class/tty/<name> is itself a symlink
 * into /sys/devices/..., and the "device" link inside it is relative to that
 * canonical location, so lexical resolution lands on a path that never exists.
 * @param {string} p
 * @returns {string|null}
 */
function canonicalPathOrNull(p) {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

/**
 * The /dev/serial/by-id link name that resolves to devicePath, or null.
 * @param {string} devicePath
 * @param {{ devRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromByIdDir(devicePath, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    const target = lexicalRealPathOrNull(devicePath);
    if (!target) return null;

    let entries;
    try {
        entries = fs.readdirSync(byIdDir(devRoot));
    } catch {
        return null; // no udev by-id links on this host
    }

    for (const entry of entries) {
        if (lexicalRealPathOrNull(path.join(byIdDir(devRoot), entry)) === target) return entry;
    }
    return null;
}

/**
 * Fallback identity for hosts without /dev/serial/by-id: walk up from
 * /sys/class/tty/<name>/device to the nearest USB device directory (the first
 * ancestor carrying idVendor and idProduct) and build vendor:product:serial.
 *
 * Returns null when that device exposes no serial number. vendor:product on
 * its own is not an identity — FTDI/CH340/CP2102 pairs are shared with a large
 * share of Zigbee and Z-Wave sticks — and adopting on it would mean grabbing
 * whichever same-model device happened to enumerate. Stopping at the nearest
 * USB device (rather than continuing up) matters for the same reason: the root
 * hub above it also has idVendor/idProduct/serial, and those are common to
 * every device on the bus.
 * @param {string} devicePath
 * @param {{ sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromSysfs(devicePath, opts = {}) {
    const sysfsRoot = opts.sysfsRoot || '/sys';
    const name = path.basename(lexicalRealPathOrNull(devicePath) || devicePath);
    let dir = canonicalPathOrNull(path.join(sysfsRoot, 'class', 'tty', name, 'device'));

    for (let depth = 0; dir && depth < 8; depth++) {
        const attrDir = dir;
        const [vendor, product, serial] = ['idVendor', 'idProduct', 'serial'].map(f => {
            try {
                return fs.readFileSync(path.join(attrDir, f), 'utf8').trim();
            } catch {
                return '';
            }
        });
        if (vendor && product) return serial ? `${vendor}:${product}:${serial}` : null;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Stable identity for a device: by-id link name preferred, sysfs as fallback.
 * Validated with isUsableIdentity before being returned — a USB string
 * descriptor can legally contain a `/`, so identityFromByIdDir/identityFromSysfs
 * can produce a non-null identity that would later be permanently rejected by
 * the load-side validation. Filtering it out here, at the point the identity
 * is produced, means callers see plain "no identity" and the caller's warning
 * about recovery being unavailable fires honestly instead of being silently
 * suppressed by a value that looks truthy but was never persistable.
 * @param {string} devicePath
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function readIdentity(devicePath, opts = {}) {
    const identity = identityFromByIdDir(devicePath, opts) || identityFromSysfs(devicePath, opts);
    return isUsableIdentity(identity) ? identity : null;
}

/**
 * Whether value is usable as a remembered identity. It is joined into
 * /dev/serial/by-id as a single path component, so a corrupt or tampered
 * /data/serial-identity.json (say `../../ttyUSB7`) must not be able to point
 * us at an arbitrary path. Fail closed: anything with a separator, a control
 * character, a leading dot, or an implausible length is rejected outright.
 * @param {unknown} value
 * @returns {value is string}
 */
function isUsableIdentity(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 255
        && !value.startsWith('.')
        // eslint-disable-next-line no-control-regex
        && !/[/\u0000-\u001f\u007f]/.test(value);
}

/**
 * Live device path for a remembered identity, or null if absent.
 * @param {string} identity
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function findDeviceByIdentity(identity, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    if (!isUsableIdentity(identity)) return null;

    // by-id identity: the link itself is the lookup. Only adopt it if it lands
    // on something that looks like a serial tty, so a stray non-device file in
    // by-id can never become the resolved device path.
    const link = path.join(byIdDir(devRoot), identity);
    const viaLink = lexicalRealPathOrNull(link);
    if (viaLink && TTY_NAME.test(path.basename(viaLink))) return viaLink;

    // sysfs identity: scan candidate ttys for a matching identity.
    let entries;
    try {
        entries = fs.readdirSync(devRoot);
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (!TTY_NAME.test(entry)) continue;
        const candidate = path.join(devRoot, entry);
        if (identityFromSysfs(candidate, opts) === identity) return candidate;
    }
    return null;
}

function loadRememberedIdentity(identityFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        return isUsableIdentity(parsed.identity) ? parsed.identity : null;
    } catch {
        return null;
    }
}

function saveRememberedIdentity(identityFile, identity) {
    // Defense in depth: readIdentity already filters unusable identities out
    // before calling this, but guard here too rather than trusting every
    // present and future caller to have validated first.
    if (!isUsableIdentity(identity)) return;
    try {
        fs.mkdirSync(path.dirname(identityFile), { recursive: true });
        fs.writeFileSync(identityFile, JSON.stringify({ identity }, null, 2));
    } catch {
        // Losing the memo only costs us recovery next boot; never fail startup.
    }
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

    if (fs.existsSync(configuredPath)) {
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

    messages.push(`Recovered: the previously-used device is now at ${recovered} — adopting it for this boot`);

    // `remembered` is only a by-id link name when recovery actually went
    // through /dev/serial/by-id — the same check findDeviceByIdentity's by-id
    // branch made. When recovery instead came through the sysfs scan (because
    // this host has no by-id links at all), `remembered` is a vendor:product:
    // serial triple, and path.join(byIdDir, remembered) would name a by-id
    // path that cannot exist — advising a user to switch cgate_serial_device
    // to it would break every future boot before recovery gets a chance to
    // run. Only recommend the by-id path when it genuinely resolves back to
    // the device we just recovered.
    const byIdPath = path.join(byIdDir(opts.devRoot), remembered);
    const byIdTarget = lexicalRealPathOrNull(byIdPath);
    const recoveredViaById = !!byIdTarget && byIdTarget === recovered && TTY_NAME.test(path.basename(byIdTarget));

    let stablePath = null;
    if (recoveredViaById) {
        stablePath = byIdPath;
        messages.push(`Update cgate_serial_device to ${stablePath} so this survives future replugs`);
    } else {
        messages.push(
            'This host has no /dev/serial/by-id link for the device, so there is no stable path to switch '
            + 'cgate_serial_device to; automatic recovery by identity will keep working on future replugs'
        );
    }
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
