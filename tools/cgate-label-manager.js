#!/usr/bin/env node

/**
 * CLI tool to manage C-Bus group labels via C-Gate.
 *
 * Connects to C-Gate's command port over TCP to discover groups and export their
 * state. Since many C-Gate installs have no tag database, this tool primarily uses
 * the TREE command for discovery and produces a backup/inventory of all groups.
 *
 * Usage:
 *   node tools/cgate-label-manager.js --export [options]
 *   node tools/cgate-label-manager.js --apply <renames.json> [options]
 *   node tools/cgate-label-manager.js --verify <renames.json> [options]
 *
 * Options:
 *   --host, -h <ip>          C-Gate IP address (default: from settings.js)
 *   --port, -p <port>        C-Gate command port (default: 20023)
 *   --project <name>         C-Bus project name (default: from settings.js or auto-detect)
 *   --network, -n <id>       Network address (default: 254)
 *   --app, -a <id>           Application address (default: 56)
 *   --output, -o <path>      Output file for --export (default: auto-timestamped)
 *   --dry-run                Print commands without executing (for --apply)
 *   --delay <ms>             Delay between commands in ms (default: 100)
 *   --help                   Show help
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const COMMAND_DELAY_MS = 100;
const CONNECT_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 10000;

function loadSettingsDefaults() {
    try {
        const settingsPath = path.resolve(__dirname, '..', 'settings.js');
        if (fs.existsSync(settingsPath)) {
            const settings = require(settingsPath);
            return {
                host: settings.cbusip || '127.0.0.1',
                port: settings.cbuscommandport || 20023,
                project: settings.cbusname || null
            };
        }
    } catch (_) { /* ignore */ }
    return { host: '127.0.0.1', port: 20023, project: null };
}

function parseArgs(argv) {
    const defaults = loadSettingsDefaults();
    const args = {
        mode: null,
        renameFile: null,
        host: defaults.host,
        port: defaults.port,
        project: defaults.project,
        network: '254',
        app: '56',
        output: null,
        dryRun: false,
        delay: COMMAND_DELAY_MS
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
                printUsage();
                process.exit(0);
                break;
            case '--export':
                args.mode = 'export';
                break;
            case '--apply':
                args.mode = 'apply';
                args.renameFile = argv[++i];
                break;
            case '--verify':
                args.mode = 'verify';
                args.renameFile = argv[++i];
                break;
            case '--host': case '-h':
                args.host = argv[++i];
                break;
            case '--port': case '-p':
                args.port = parseInt(argv[++i], 10);
                break;
            case '--project':
                args.project = argv[++i];
                break;
            case '--network': case '-n':
                args.network = argv[++i];
                break;
            case '--app': case '-a':
                args.app = argv[++i];
                break;
            case '--output': case '-o':
                args.output = argv[++i];
                break;
            case '--dry-run':
                args.dryRun = true;
                break;
            case '--delay':
                args.delay = parseInt(argv[++i], 10);
                break;
            default:
                if (!arg.startsWith('-') && !args.renameFile && args.mode !== 'export') {
                    args.renameFile = arg;
                } else if (arg.startsWith('-')) {
                    console.error(`Unknown option: ${arg}`);
                    printUsage();
                    process.exit(1);
                }
        }
    }

    return args;
}

function printUsage() {
    console.log(`
Usage:
  node tools/cgate-label-manager.js --export [options]
  node tools/cgate-label-manager.js --apply <renames.json> [options]
  node tools/cgate-label-manager.js --verify <renames.json> [options]

Modes:
  --export              Discover all C-Bus groups via TREE and save inventory to JSON
  --apply <file>        Apply renames from a JSON map file via DBSET commands
  --verify <file>       Read labels via DBGET and compare against the rename map

Options:
  --host, -h <ip>       C-Gate IP (default: from settings.js or 127.0.0.1)
  --port, -p <port>     C-Gate command port (default: 20023)
  --project <name>      C-Bus project name (default: auto-detect from TREE)
  --network, -n <id>    Network address (default: 254)
  --app, -a <id>        Application address (default: 56)
  --output, -o <path>   Output file for --export (default: cbus-labels-backup-<date>.json)
  --dry-run             Print DBSET commands without executing (use with --apply)
  --delay <ms>          Delay between C-Gate commands in ms (default: 100)
  --help                Show this help

Notes:
  If C-Gate has no tag database loaded, --apply and --verify will not work.
  The --export mode uses TREE which always works regardless of tag database.

Examples:
  node tools/cgate-label-manager.js --export --host 192.168.0.22
  node tools/cgate-label-manager.js --export --host 192.168.0.22 --network 254
  node tools/cgate-label-manager.js --apply renames.json --dry-run
  node tools/cgate-label-manager.js --apply renames.json --host 192.168.0.22
`.trim());
}

class CgateClient {
    constructor(host, port) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.buffer = '';
        this.lineQueue = [];
        this.lineWaiters = [];
        this.connected = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
                if (this.socket) this.socket.destroy();
            }, CONNECT_TIMEOUT_MS);

            this.socket = net.createConnection(this.port, this.host);

            this.socket.on('connect', () => {
                clearTimeout(timeout);
                this.connected = true;
            });

            this.socket.on('data', (data) => {
                this.buffer += data.toString();
                this._drainBuffer();
            });

            this.socket.on('error', (err) => {
                clearTimeout(timeout);
                if (!this.connected) {
                    reject(new Error(`Connection failed: ${err.message}`));
                }
            });

            this.socket.on('close', () => {
                this.connected = false;
                while (this.lineWaiters.length > 0) {
                    this.lineWaiters.shift().reject(new Error('Connection closed'));
                }
            });

            this._waitForLine().then(line => {
                if (line.startsWith('201 ')) {
                    resolve(line);
                } else {
                    reject(new Error(`Unexpected banner: ${line}`));
                }
            }).catch(reject);
        });
    }

    _drainBuffer() {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line) continue;

            if (this.lineWaiters.length > 0) {
                this.lineWaiters.shift().resolve(line);
            } else {
                this.lineQueue.push(line);
            }
        }
    }

    _waitForLine() {
        if (this.lineQueue.length > 0) {
            return Promise.resolve(this.lineQueue.shift());
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.lineWaiters.findIndex(w => w.timer === timer);
                if (idx !== -1) this.lineWaiters.splice(idx, 1);
                reject(new Error('Timeout waiting for response'));
            }, RESPONSE_TIMEOUT_MS);
            this.lineWaiters.push({ resolve, reject, timer });
        });
    }

    /**
     * Send a command and collect the full response.
     * C-Gate uses continuation lines like "3xx-..." and terminates with "3xx " or error codes.
     * Returns an array of response lines.
     */
    async sendCommand(cmd) {
        if (!this.connected || !this.socket) {
            throw new Error('Not connected');
        }
        this.socket.write(cmd + '\n');

        const lines = [];
        while (true) {
            const line = await this._waitForLine();
            lines.push(line);

            const code = line.substring(0, 3);
            const separator = line[3];

            if (/^\d{3}$/.test(code)) {
                if (separator === '-') {
                    continue;
                }
                break;
            }
            break;
        }
        return lines;
    }

    disconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        while (this.lineWaiters.length > 0) {
            const w = this.lineWaiters.shift();
            clearTimeout(w.timer);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadRenameMap(filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        console.error(`Error: Rename map file not found: ${resolved}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!data.renames || typeof data.renames !== 'object') {
        console.error('Error: Rename map must contain a "renames" object');
        process.exit(1);
    }
    return data;
}

function cgateObjectPath(project, network, app, group) {
    return `//${project}/${network}/${app}/${group}`;
}

/**
 * Parse TREE output to extract groups for a specific application.
 * TREE lines look like:
 *   320-  //CLIPSAL/254/56/4 ($4) level=0 state=ok units=37
 * Returns { project, groups: [{address, level, state, units}] }
 */
function parseTreeGroups(lines, networkId, appId) {
    let detectedProject = null;
    const groups = [];
    const groupRegex = /^320-\s+\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)\s+\(\$[\da-f]+\)\s+level=(\d+)\s+state=(\w+)\s+units=([\d,]*)/i;

    for (const line of lines) {
        const m = groupRegex.exec(line);
        if (m) {
            const [, proj, net, app, addr, level, state, units] = m;
            if (!detectedProject) detectedProject = proj;
            if (net === String(networkId) && app === String(appId)) {
                groups.push({
                    address: addr,
                    level: parseInt(level, 10),
                    state,
                    units: units ? units.split(',').filter(Boolean) : []
                });
            }
        }
    }

    return { project: detectedProject, groups };
}

async function doExport(client, args) {
    const { network, app } = args;

    console.log(`\nQuerying TREE for network ${network} ...\n`);

    const treeLines = await client.sendCommand(`TREE ${network}`);

    const { project: detectedProject, groups } = parseTreeGroups(treeLines, network, app);

    if (detectedProject && !args.project) {
        args.project = detectedProject;
        console.log(`Auto-detected project name: ${detectedProject}`);
    }

    const project = args.project || detectedProject || 'UNKNOWN';

    groups.sort((a, b) => parseInt(a.address) - parseInt(b.address));

    console.log(`Found ${groups.length} groups on //${project}/${network}/${app}:\n`);

    if (groups.length > 0) {
        const maxAddr = Math.max(...groups.map(g => g.address.length));
        for (const g of groups) {
            const levelStr = `level=${String(g.level).padStart(3)}`;
            const unitsStr = g.units.length > 0 ? `units=${g.units.join(',')}` : '';
            console.log(`  ${g.address.padStart(maxAddr)}  ${levelStr}  ${g.state}  ${unitsStr}`);
        }
    }

    const outputFile = args.output || `cbus-labels-backup-${new Date().toISOString().split('T')[0]}.json`;
    const outputData = {
        exported: new Date().toISOString(),
        project,
        network,
        application: app,
        note: 'No tag database on this C-Gate instance. Labels are managed via labels.json.',
        groups
    };
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2) + '\n', 'utf8');
    console.log(`\nBackup saved to ${outputFile}`);
    return groups;
}

async function doApply(client, args) {
    const renameMap = loadRenameMap(args.renameFile);
    const project = renameMap.project || args.project;
    const network = renameMap.network || args.network;
    const app = renameMap.application || args.app;

    if (!project) {
        console.error('Error: No project name specified. Use --project or set it in the rename map.');
        process.exit(1);
    }

    const renames = Object.entries(renameMap.renames);
    const deletes = renameMap.delete || [];

    console.log(`\n${args.dryRun ? '[DRY RUN] ' : ''}Applying ${renames.length} renames and ${deletes.length} deletes to //${project}/${network}/${app}\n`);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const [addr, newLabel] of renames) {
        const objPath = cgateObjectPath(project, network, app, addr);
        const cmd = `DBSET ${objPath} TagName="${newLabel}"`;

        if (args.dryRun) {
            console.log(`  [DRY RUN] ${cmd}`);
            skipped++;
            continue;
        }

        try {
            const resp = await client.sendCommand(cmd);
            const firstLine = resp[0] || '';
            if (firstLine.startsWith('200 ')) {
                console.log(`  OK  ${addr.padStart(3)} -> "${newLabel}"`);
                success++;
            } else {
                console.log(`  ERR ${addr.padStart(3)} -> "${newLabel}" : ${firstLine}`);
                failed++;
            }
        } catch (err) {
            console.log(`  ERR ${addr.padStart(3)} -> "${newLabel}" : ${err.message}`);
            failed++;
        }
        await sleep(args.delay);
    }

    for (const addr of deletes) {
        const objPath = cgateObjectPath(project, network, app, addr);
        const cmd = `DBSET ${objPath} TagName="<Unused>"`;

        if (args.dryRun) {
            console.log(`  [DRY RUN] ${cmd}`);
            skipped++;
            continue;
        }

        try {
            const resp = await client.sendCommand(cmd);
            const firstLine = resp[0] || '';
            if (firstLine.startsWith('200 ')) {
                console.log(`  OK  ${String(addr).padStart(3)} -> <Unused> (deleted)`);
                success++;
            } else {
                console.log(`  ERR ${String(addr).padStart(3)} -> delete : ${firstLine}`);
                failed++;
            }
        } catch (err) {
            console.log(`  ERR ${String(addr).padStart(3)} -> delete : ${err.message}`);
            failed++;
        }
        await sleep(args.delay);
    }

    console.log(`\n${args.dryRun ? '[DRY RUN] ' : ''}Summary: ${success} succeeded, ${failed} failed, ${skipped} skipped`);

    if (!args.dryRun && failed === 0 && success > 0) {
        console.log('\nRunning automatic verification...');
        await doVerify(client, args);
    }

    return { success, failed, skipped };
}

async function doVerify(client, args) {
    const renameMap = loadRenameMap(args.renameFile);
    const project = renameMap.project || args.project;
    const network = renameMap.network || args.network;
    const app = renameMap.application || args.app;

    if (!project) {
        console.error('Error: No project name specified. Use --project or set it in the rename map.');
        process.exit(1);
    }

    const renames = Object.entries(renameMap.renames);
    console.log(`\nVerifying ${renames.length} labels on //${project}/${network}/${app} ...\n`);

    let matched = 0;
    let mismatched = 0;
    let errors = 0;

    for (const [addr, expected] of renames) {
        const objPath = cgateObjectPath(project, network, app, addr);
        try {
            const resp = await client.sendCommand(`DBGET ${objPath} TagName`);
            const firstLine = resp[0] || '';
            if (firstLine.startsWith('300 ')) {
                const tagMatch = firstLine.match(/TagName="([^"]*)"/);
                const actual = tagMatch ? tagMatch[1] : '(parse error)';
                if (actual === expected) {
                    matched++;
                } else {
                    console.log(`  MISMATCH ${addr.padStart(3)}: expected "${expected}" got "${actual}"`);
                    mismatched++;
                }
            } else {
                console.log(`  ERROR    ${addr.padStart(3)}: ${firstLine}`);
                errors++;
            }
        } catch (err) {
            console.log(`  ERROR    ${addr.padStart(3)}: ${err.message}`);
            errors++;
        }
        await sleep(args.delay);
    }

    console.log(`\nVerification: ${matched} matched, ${mismatched} mismatched, ${errors} errors`);

    if (mismatched === 0 && errors === 0) {
        console.log('All labels verified successfully.');
    }

    return { matched, mismatched, errors };
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.mode) {
        console.error('Error: No mode specified. Use --export, --apply, or --verify.\n');
        printUsage();
        process.exit(1);
    }

    if ((args.mode === 'apply' || args.mode === 'verify') && !args.renameFile) {
        console.error(`Error: --${args.mode} requires a rename map JSON file.\n`);
        printUsage();
        process.exit(1);
    }

    if (args.dryRun && args.mode === 'apply') {
        console.log('=== DRY RUN MODE - No changes will be made ===\n');
        const renameMap = loadRenameMap(args.renameFile);
        const project = renameMap.project || args.project || 'PROJECT';
        const network = renameMap.network || args.network;
        const app = renameMap.application || args.app;

        const renames = Object.entries(renameMap.renames);
        const deletes = renameMap.delete || [];

        console.log(`Target: //${project}/${network}/${app}`);
        console.log(`Renames: ${renames.length}, Deletes: ${deletes.length}\n`);

        for (const [addr, newLabel] of renames) {
            const objPath = cgateObjectPath(project, network, app, addr);
            console.log(`DBSET ${objPath} TagName="${newLabel}"`);
        }
        for (const addr of deletes) {
            const objPath = cgateObjectPath(project, network, app, addr);
            console.log(`DBSET ${objPath} TagName="<Unused>"`);
        }

        console.log(`\n=== ${renames.length + deletes.length} commands would be executed ===`);
        process.exit(0);
    }

    console.log(`Connecting to C-Gate at ${args.host}:${args.port}...`);
    const client = new CgateClient(args.host, args.port);

    try {
        const banner = await client.connect();
        console.log(`Connected: ${banner}`);

        switch (args.mode) {
            case 'export':
                await doExport(client, args);
                break;
            case 'apply':
                await doApply(client, args);
                break;
            case 'verify':
                await doVerify(client, args);
                break;
        }
    } catch (err) {
        console.error(`\nError: ${err.message}`);
        process.exit(1);
    } finally {
        client.disconnect();
    }
}

main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
