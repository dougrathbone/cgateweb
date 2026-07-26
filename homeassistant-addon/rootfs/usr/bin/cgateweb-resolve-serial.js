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
 * The configured path merely existing is not enough: two USB serial dongles can
 * trade ttyUSBn names between boots, so when the device at the configured path
 * has a different identity than the remembered one, the remembered device is
 * preferred while it is still present (and the memo is never overwritten with
 * the other device's identity). Only when the remembered device has genuinely
 * gone — a deliberate PC Interface swap — does the configured path win and get
 * its new identity recorded.
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
 * Prints the effective path on stdout and writes it to
 * CGATEWEB_SERIAL_DEVICE_FILE (default /run/cgateweb/serial-device) so the
 * later boot scripts use the same answer. Diagnostics go to stderr, one per
 * line, tagged "INFO: " or "WARN: " so the caller can log each at the level it
 * deserves.
 *
 * Exit codes:
 *   0  resolved (path on stdout)
 *   1  the configured device is not present and could not be recovered
 *   2  any other failure: bad usage, or a recovered path that could not be
 *      published (see main() for why only the recovered case is fatal)
 *
 * CGATEWEB_SERIAL_DEV_ROOT / CGATEWEB_SERIAL_SYSFS_ROOT relocate /dev and /sys
 * so the tests can drive the CLI against a fabricated device tree.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEVICE_FILE = '/run/cgateweb/serial-device';
const DEFAULT_IDENTITY_FILE = '/data/serial-identity.json';

const EXIT_UNRESOLVED = 1;
const EXIT_OTHER_FAILURE = 2;

// Diagnostics carry a level so the caller does not have to guess: "the device
// vanished" and "here is a nicer path you could configure" are both stderr
// lines, but only one of them is a warning.
/** @param {string} text @returns {{level: 'info'|'warning', text: string}} */
const info = text => ({ level: 'info', text });
/** @param {string} text @returns {{level: 'info'|'warning', text: string}} */
const warn = text => ({ level: 'warning', text });
const LEVEL_TAG = { info: 'INFO', warning: 'WARN' };

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
 * Finish a resolution that adopted a path other than the configured one:
 * recommend the by-id path when one genuinely resolves to the adopted device,
 * and explain why there is none when it does not.
 *
 * `remembered` is only a by-id link name when the lookup actually went through
 * /dev/serial/by-id — the same check findDeviceByIdentity's by-id branch made.
 * When it instead came through the sysfs scan (because this host has no by-id
 * links at all), `remembered` is a vendor:product:serial triple, and
 * path.join(byIdDir, remembered) would name a by-id path that cannot exist —
 * advising a user to switch cgate_serial_device to it would break every future
 * boot before recovery gets a chance to run. Only recommend the by-id path when
 * it genuinely resolves back to the device just adopted.
 *
 * @param {string} remembered
 * @param {string} adopted
 * @param {{ devRoot?: string, sysfsRoot?: string }} opts
 * @param {Array<{level: 'info'|'warning', text: string}>} messages
 * @returns {{ path: string, source: 'recovered', identity: string, stablePath: string|null, messages: Array<{level: 'info'|'warning', text: string}> }}
 */
function adoptedByIdentityResult(remembered, adopted, opts, messages) {
    const byIdPath = path.join(byIdDir(opts.devRoot), remembered);
    const byIdTarget = lexicalRealPathOrNull(byIdPath);
    const foundViaById = !!byIdTarget && byIdTarget === adopted && TTY_NAME.test(path.basename(byIdTarget));

    let stablePath = null;
    if (foundViaById) {
        stablePath = byIdPath;
        messages.push(info(`Update cgate_serial_device to ${stablePath} so this survives future replugs`));
    } else {
        messages.push(info(
            'This host has no /dev/serial/by-id link for the device, so there is no stable path to switch '
            + 'cgate_serial_device to; automatic recovery by identity will keep working on future replugs'
        ));
    }
    return { path: adopted, source: 'recovered', identity: remembered, stablePath, messages };
}

/**
 * @param {object} args
 * @param {string} args.configuredPath
 * @param {string} [args.identityFile]
 * @param {string} [args.devRoot]
 * @param {string} [args.sysfsRoot]
 * @returns {{ path: string|null, source: 'configured'|'recovered', identity: string|null, stablePath: string|null, messages: Array<{level: 'info'|'warning', text: string}> }}
 */
function resolveSerialDevice(args) {
    const { configuredPath } = args;
    const identityFile = args.identityFile || DEFAULT_IDENTITY_FILE;
    const opts = { devRoot: args.devRoot || '/dev', sysfsRoot: args.sysfsRoot || '/sys' };
    const messages = [];

    if (fs.existsSync(configuredPath)) {
        // Computed once and reused below for the stable-path hint, rather than
        // calling identityFromByIdDir(configuredPath, opts) again — it walks the
        // symlink chain and scans /dev/serial/by-id, both synchronous, on every
        // boot. Mirrors readIdentity's own by-id-then-sysfs precedence.
        const byIdName = identityFromByIdDir(configuredPath, opts);
        const rawIdentity = byIdName || identityFromSysfs(configuredPath, opts);
        const identity = isUsableIdentity(rawIdentity) ? rawIdentity : null;

        // The configured path existing is NOT proof it is still our device.
        // Two USB serial dongles (say a Zigbee stick and the PC Interface) can
        // trade ttyUSBn between boots depending on enumeration order, so
        // /dev/ttyUSB0 can be the Zigbee stick this boot. Pointing C-Gate at it
        // opens a C-Bus network that never comes up, and — worse — recording
        // its identity over the remembered one would destroy the only means of
        // finding either device again. So when the identity here disagrees with
        // the remembered one, the remembered device wins if it is still present.
        const remembered = loadRememberedIdentity(identityFile);
        if (identity && remembered && identity !== remembered) {
            const rememberedPath = findDeviceByIdentity(remembered, opts);
            // Same device, different identity form (e.g. this host gained
            // /dev/serial/by-id links since the last boot, so the by-id name
            // now outranks the sysfs triple that was recorded): nothing has
            // moved, just re-record below under the preferred identity.
            if (rememberedPath && rememberedPath !== lexicalRealPathOrNull(configuredPath)) {
                messages.push(warn(
                    `${configuredPath} exists but is a different device than the one recorded on the last good boot `
                    + `(expected ${remembered}, found ${identity}) — USB serial devices can trade names between boots`
                ));
                messages.push(warn(
                    `Recovered: the previously-used device is now at ${rememberedPath} — adopting it for this boot `
                    + `instead of the configured ${configuredPath}`
                ));
                return adoptedByIdentityResult(remembered, rememberedPath, opts, messages);
            }
            if (!rememberedPath) {
                // A deliberate hardware swap looks exactly like this: the old
                // interface is gone for good and its replacement answers at the
                // configured path. Adopt it and re-record, so recovery keeps
                // working for the device the user actually has now.
                messages.push(warn(
                    `The device recorded on the last good boot (${remembered}) is no longer present; `
                    + `${configuredPath} now holds a different device (${identity}) — adopting it and recording its identity`
                ));
            }
        }

        if (identity) saveRememberedIdentity(identityFile, identity);
        else messages.push(warn(`No stable identity found for ${configuredPath}; automatic recovery after a replug will not be possible`));

        // Recommend the stable path whenever a raw tty path was configured.
        let stablePath = null;
        if (byIdName) {
            stablePath = path.join(byIdDir(opts.devRoot), byIdName);
            if (path.resolve(configuredPath) !== stablePath) {
                messages.push(info(`Prefer the stable path: set cgate_serial_device to ${stablePath}`));
            }
        }
        return { path: configuredPath, source: 'configured', identity, stablePath, messages };
    }

    messages.push(warn(`Serial device not found: ${configuredPath}`));
    const remembered = loadRememberedIdentity(identityFile);
    if (!remembered) {
        messages.push(warn('No previously-recorded device identity, so the new path cannot be identified automatically'));
        return { path: null, source: 'configured', identity: null, stablePath: null, messages };
    }

    const recovered = findDeviceByIdentity(remembered, opts);
    if (!recovered) {
        messages.push(warn(`Previously-used device (${remembered}) is not present either; is the PC Interface plugged in?`));
        return { path: null, source: 'configured', identity: remembered, stablePath: null, messages };
    }

    messages.push(warn(`Recovered: the previously-used device is now at ${recovered} — adopting it for this boot`));
    return adoptedByIdentityResult(remembered, recovered, opts, messages);
}

function main() {
    const configuredPath = process.argv[2];
    if (!configuredPath) {
        console.error(`${LEVEL_TAG.warning}: usage: cgateweb-resolve-serial.js <configured-device-path>`);
        process.exit(EXIT_OTHER_FAILURE);
    }

    const result = resolveSerialDevice({
        configuredPath,
        identityFile: process.env.CGATEWEB_SERIAL_IDENTITY_FILE || DEFAULT_IDENTITY_FILE,
        devRoot: process.env.CGATEWEB_SERIAL_DEV_ROOT || '/dev',
        sysfsRoot: process.env.CGATEWEB_SERIAL_SYSFS_ROOT || '/sys'
    });
    for (const message of result.messages) {
        console.error(`${LEVEL_TAG[message.level]}: ${message.text}`);
    }

    if (!result.path) process.exit(EXIT_UNRESOLVED);

    const deviceFile = process.env.CGATEWEB_SERIAL_DEVICE_FILE || DEFAULT_DEVICE_FILE;
    try {
        fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
        fs.writeFileSync(deviceFile, result.path);
    } catch (e) {
        // Whether an unpublished answer matters depends entirely on whether we
        // changed it. The consumers (cgate-project-sync.sh, the serial
        // diagnostics) fall back to reading cgate_serial_device when this file
        // is missing, so:
        //   - path unchanged: their fallback lands on exactly this path anyway.
        //     Warn and carry on; aborting add-on startup over a /run that could
        //     not be written would be a self-inflicted outage.
        //   - path recovered: their fallback lands on the stale configured path
        //     and the project rewrite would point C-Gate at a port that no
        //     longer exists. That silent misconfiguration is worse than a loud
        //     failure, so fail — naming the write, not the device.
        console.error(`${LEVEL_TAG.warning}: Could not write ${deviceFile}: ${e.message}`);
        if (result.path !== configuredPath) {
            console.error(
                `${LEVEL_TAG.warning}: The device was recovered at ${result.path}, but that could not be shared `
                + `with the later boot steps, which would fall back to the stale ${configuredPath}`
            );
            process.exit(EXIT_OTHER_FAILURE);
        }
        console.error(
            `${LEVEL_TAG.warning}: Later boot steps will fall back to cgate_serial_device, which is the same `
            + `path (${result.path}), so this is not fatal`
        );
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
