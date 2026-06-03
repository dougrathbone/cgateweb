#!/usr/bin/env node
'use strict';

/*
 * capture-cbus-events.js
 * ----------------------
 * Interactive C-Bus event capture tool for diagnosing HVAC / Air-Conditioning
 * (application 172), Measurement (228) and Temperature Broadcast (25) traffic.
 *
 * It connects to either:
 *   1) C-Gate  (RECOMMENDED — the same interface cgateweb uses), or
 *   2) a CNI / PCI directly over TCP (advanced raw tap).
 *
 * Everything received is timestamped and written to a capture file. While it
 * runs you can type short LABELS that get inserted into the file as markers,
 * so you can annotate exactly which physical action produced which events
 * (e.g. type "set thermostat to 21.5" right before changing it).
 *
 * Zero dependencies — Node.js >= 18 only.
 *
 * USAGE:
 *   node capture-cbus-events.js
 *
 * When finished, send the generated capture file (cbus-capture-*.log) back to
 * whoever asked you to run this. It contains only C-Bus protocol lines and the
 * labels you type — no credentials are written to it.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const TOOL_VERSION = '1.0.0';

function nowIso() {
    return new Date().toISOString();
}

function fileTimestamp() {
    // 2026-06-03T10-15-42 — filesystem-safe.
    return nowIso().replace(/:/g, '-').replace(/\..+$/, '');
}

/**
 * Renders a raw byte buffer as "hex | printable-ascii" for CNI captures.
 */
function formatRawBytes(buf) {
    const hex = buf.toString('hex').replace(/(..)/g, '$1 ').trim();
    let ascii = '';
    for (const byte of buf) {
        ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
    }
    return `hex=[${hex}] ascii=[${ascii}]`;
}

/**
 * Splits a TCP stream into lines (\r\n or \n), invoking onLine for each
 * complete line. Used for the text-based C-Gate interface.
 */
function makeLineSplitter(onLine) {
    let buffer = '';
    return (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line.length > 0) onLine(line);
        }
    };
}

/**
 * The capture sink: writes timestamped, source-tagged lines to a file and
 * echoes a compact form to the console so the operator can see live activity.
 */
class Capture {
    constructor(filePath) {
        this.filePath = filePath;
        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
        this.count = 0;
    }

    header(meta) {
        this.stream.write(`# cbus-capture v${TOOL_VERSION} started ${nowIso()}\n`);
        for (const [k, v] of Object.entries(meta)) {
            this.stream.write(`# ${k}: ${v}\n`);
        }
        this.stream.write('# columns: <iso-timestamp>\\t<source>\\t<data>\n');
        this.stream.write('#\n');
    }

    record(source, data) {
        this.count += 1;
        this.stream.write(`${nowIso()}\t${source}\t${data}\n`);
        // Compact console echo (truncate very long lines).
        const shown = data.length > 160 ? `${data.slice(0, 157)}...` : data;
        stdout.write(`  ${source.padEnd(4)} | ${shown}\n`);
    }

    marker(text) {
        this.stream.write(`\n=== MARKER @ ${nowIso()}: ${text} ===\n\n`);
        stdout.write(`  >>>> marker saved: "${text}"\n`);
    }

    close(reason) {
        return new Promise((resolve) => {
            this.stream.write(`#\n# capture ended ${nowIso()} (${reason}); ${this.count} line(s) recorded\n`);
            this.stream.end(resolve);
        });
    }
}

// --- Connection setup -------------------------------------------------------

function connectSocket(host, port, label) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port }, () => resolve(socket));
        socket.setNoDelay(true);
        socket.once('error', reject);
        socket.setTimeout(15000, () => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ${label} at ${host}:${port}`));
        });
    });
}

async function setupCgate(answers, capture) {
    const { host, commandPort, eventPort, username, password } = answers;

    // 1) Command connection: lets us authenticate and turn events on. Some
    //    C-Gate configurations only emit events to sessions that issued
    //    "EVENT ON", so we keep this open alongside the dedicated event port.
    stdout.write(`Connecting to C-Gate command port ${host}:${commandPort} ...\n`);
    const cmd = await connectSocket(host, commandPort, 'C-Gate command port');
    cmd.setTimeout(0);
    cmd.on('data', makeLineSplitter((line) => capture.record('CMD', line)));
    cmd.on('error', (e) => capture.record('CMD', `[socket error] ${e.message}`));
    cmd.on('close', () => capture.record('CMD', '[command connection closed]'));
    stdout.write('  [ok] command port connected\n');

    const send = (text) => cmd.write(`${text}\r\n`);

    // Give the banner a moment, then authenticate if credentials were given.
    await delay(400);
    if (username) {
        send(`LOGIN ${username} ${password || ''}`);
        stdout.write('  [ok] sent LOGIN\n');
        await delay(400);
    }
    send('EVENT ON');
    stdout.write('  [ok] sent EVENT ON\n');

    // 2) Dedicated event connection: the always-on broadcast stream that
    //    cgateweb itself reads. This is the most faithful capture.
    try {
        stdout.write(`Connecting to C-Gate event port ${host}:${eventPort} ...\n`);
        const evt = await connectSocket(host, eventPort, 'C-Gate event port');
        evt.setTimeout(0);
        evt.on('data', makeLineSplitter((line) => capture.record('EVT', line)));
        evt.on('error', (e) => capture.record('EVT', `[socket error] ${e.message}`));
        evt.on('close', () => capture.record('EVT', '[event connection closed]'));
        stdout.write('  [ok] event port connected\n');
        return [cmd, evt];
    } catch (e) {
        stdout.write(`  [warn] could not open event port (${e.message}). Continuing with the command\n` +
                     `         connection's EVENT ON stream, which is usually enough.\n`);
        return [cmd];
    }
}

async function setupCni(answers, capture) {
    const { host, port, initHex } = answers;
    stdout.write(`Connecting to CNI/PCI ${host}:${port} ...\n`);
    const sock = await connectSocket(host, port, 'CNI');
    sock.setTimeout(0);
    sock.on('data', (chunk) => capture.record('CNI', formatRawBytes(chunk)));
    sock.on('error', (e) => capture.record('CNI', `[socket error] ${e.message}`));
    sock.on('close', () => capture.record('CNI', '[CNI connection closed]'));
    stdout.write('  [ok] CNI connected (raw tap)\n');

    if (initHex) {
        const clean = initHex.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length % 2 !== 0) {
            stdout.write('  [warn] init hex has an odd number of digits; ignoring it.\n');
        } else {
            sock.write(Buffer.from(clean, 'hex'));
            capture.record('CNI', `[sent init bytes] hex=[${clean}]`);
            stdout.write('  [ok] sent init bytes\n');
        }
    }
    return [sock];
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Interactive flow -------------------------------------------------------

const INTRO = `
C-Bus Event Capture Tool  (v${TOOL_VERSION})
============================================
Records raw C-Bus events so your HVAC / Air-Conditioning (app 172),
Measurement (228) and Temperature (25) messages can be decoded natively.

Two modes:
  1) C-Gate      RECOMMENDED. Uses the same interface cgateweb uses.
  2) CNI direct  ADVANCED. Raw tap straight off the network interface.
                 NOTE: a CNI usually allows only ONE connection, so you must
                 STOP cgateweb / C-Gate first, and the PCI must already be in
                 monitor mode. If unsure, use C-Gate mode.
`;

const PLAYBOOK = `
-------------------------------------------------------------------------
CAPTURING. Leave this running and perform actions at the wall controller /
thermostat. BEFORE each action, type a short label and press Enter so we know
what produced the events. Suggested sequence:

  1. Type:  baseline (no changes)        -> wait ~10s, do nothing
  2. Type:  set setpoint to 21.5         -> set the thermostat to 21.5C
  3. Type:  set setpoint to 23.0         -> change it to 23.0C
  4. Type:  mode heat                    -> switch the unit to HEAT
  5. Type:  mode cool                    -> switch to COOL
  6. Type:  mode off                     -> turn the unit OFF
  7. Type:  fan high / fan low           -> change fan speed if available

Always include the ACTUAL value you set (e.g. "21.5") — that lets us confirm
the encoding rather than guess it.

Type  q  then Enter to stop and save.  (Ctrl-C also stops and saves.)
-------------------------------------------------------------------------
`;

async function main() {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    stdout.write(INTRO);

    const mode = (await rl.question('Select mode [1=C-Gate, 2=CNI] (1): ')).trim() || '1';

    let answers;
    let setupFn;
    let metaForFile;

    if (mode === '2') {
        const host = (await rl.question('CNI host/IP: ')).trim();
        if (!host) { stdout.write('No host given. Exiting.\n'); rl.close(); return; }
        const port = parseInt((await rl.question('CNI TCP port (10001): ')).trim() || '10001', 10);
        stdout.write(
            'Optional PCI monitor-init bytes as hex (leave blank if your CNI is\n' +
            'already in monitor mode or you are unsure — C-Gate mode is safer):\n');
        const initHex = (await rl.question('Init hex (blank): ')).trim();
        answers = { host, port, initHex };
        setupFn = setupCni;
        metaForFile = { mode: 'cni-direct', host, port };
    } else {
        const host = (await rl.question('C-Gate host/IP (127.0.0.1): ')).trim() || '127.0.0.1';
        const commandPort = parseInt((await rl.question('C-Gate command port (20023): ')).trim() || '20023', 10);
        const eventPort = parseInt((await rl.question('C-Gate event port (20025): ')).trim() || '20025', 10);
        const username = (await rl.question('C-Gate username (blank if none): ')).trim();
        let password = '';
        if (username) {
            password = (await rl.question('C-Gate password: ')).trim();
        }
        answers = { host, commandPort, eventPort, username, password };
        setupFn = setupCgate;
        // Credentials are deliberately excluded from the capture file metadata.
        metaForFile = { mode: 'cgate', host, commandPort, eventPort, authenticated: username ? 'yes' : 'no' };
    }

    const defaultFile = path.resolve(process.cwd(), `cbus-capture-${fileTimestamp()}.log`);
    const fileAnswer = (await rl.question(`Output file (${defaultFile}): `)).trim();
    const filePath = fileAnswer || defaultFile;

    const capture = new Capture(filePath);
    capture.header(metaForFile);

    let sockets = [];
    try {
        sockets = await setupFn(answers, capture);
    } catch (e) {
        stdout.write(`\n[error] ${e.message}\n`);
        if (mode !== '2') {
            stdout.write('Check the host/ports and that C-Gate is running and reachable.\n');
        }
        await capture.close(`setup failed: ${e.message}`);
        rl.close();
        process.exitCode = 1;
        return;
    }

    stdout.write(PLAYBOOK);

    let finished = false;
    const finish = async (reason) => {
        if (finished) return;
        finished = true;
        for (const s of sockets) s.destroy();
        await capture.close(reason);
        rl.close();
        stdout.write(`\nSaved ${capture.count} line(s) to:\n  ${filePath}\n`);
        stdout.write('Please send that file back. Thank you!\n');
    };

    // Markers: every non-"q" line typed becomes an annotation in the capture.
    rl.on('line', (input) => {
        const text = input.trim();
        if (text.toLowerCase() === 'q') {
            finish('user typed q').then(() => process.exit(0));
            return;
        }
        if (text.length > 0) capture.marker(text);
    });

    // Ctrl-C also stops cleanly and flushes the file.
    process.on('SIGINT', () => {
        stdout.write('\n');
        finish('SIGINT').then(() => process.exit(0));
    });
}

main().catch((e) => {
    stdout.write(`\nUnexpected error: ${e.stack || e.message}\n`);
    process.exitCode = 1;
});
