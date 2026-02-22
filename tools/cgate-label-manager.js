#!/usr/bin/env node

/**
 * CLI tool to manage C-Bus group labels directly via C-Gate.
 *
 * Connects to C-Gate's command port over TCP and executes DBGET/DBSET/DBDELETE
 * commands to export, rename, and verify group labels in the tag database.
 *
 * Usage:
 *   node tools/cgate-label-manager.js --export [options]
 *   node tools/cgate-label-manager.js --apply <renames.json> [options]
 *   node tools/cgate-label-manager.js --verify <renames.json> [options]
 *
 * Options:
 *   --host, -h <ip>          C-Gate IP address (default: from settings.js)
 *   --port, -p <port>        C-Gate command port (default: 20023)
 *   --project <name>         C-Bus project name (default: from settings.js)
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
const RESPONSE_TIMEOUT_MS = 5000;

function loadSettingsDefaults() {
    try {
        const settingsPath = path.resolve(__dirname, '..', 'settings.js');
        if (fs.existsSync(settingsPath)) {
            const settings = require(settingsPath);
            return {
                host: settings.cbusip || '127.0.0.1',
                port: settings.cbuscommandport || 20023,
                project: settings.cbusname || 'CLIPSAL'
            };
        }
    } catch (_) { /* ignore */ }
    return { host: '127.0.0.1', port: 20023, project: 'CLIPSAL' };
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
  --export              Read all group labels from C-Gate and save to a backup JSON file
  --apply <file>        Apply renames from a JSON map file via DBSET commands
  --verify <file>       Read labels and compare against the rename map, report mismatches

Options:
  --host, -h <ip>       C-Gate IP (default: from settings.js or 127.0.0.1)
  --port, -p <port>     C-Gate command port (default: 20023)
  --project <name>      C-Bus project name (default: from settings.js)
  --network, -n <id>    Network address (default: 254)
  --app, -a <id>        Application address (default: 56)
  --output, -o <path>   Output file for --export (default: cbus-labels-backup-<date>.json)
  --dry-run             Print DBSET commands without executing (use with --apply)
  --delay <ms>          Delay between C-Gate commands in ms (default: 100)
  --help                Show this help

Examples:
  node tools/cgate-label-manager.js --export --host 192.168.0.2 --project 5COGAN
  node tools/cgate-label-manager.js --apply renames.json --dry-run
  node tools/cgate-label-manager.js --apply renames.json --host 192.168.0.2 --project 5COGAN
  node tools/cgate-label-manager.js --verify renames.json --host 192.168.0.2 --project 5COGAN
`.trim());
}

class CgateClient {
    constructor(host, port) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.buffer = '';
        this.responseResolve = null;
        this.responseReject = null;
        this.responseTimeout = null;
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
                this._processBuffer(resolve);
            });

            this.socket.on('error', (err) => {
                clearTimeout(timeout);
                if (!this.connected) {
                    reject(new Error(`Connection failed: ${err.message}`));
                } else if (this.responseReject) {
                    this.responseReject(err);
                    this.responseResolve = null;
                    this.responseReject = null;
                }
            });

            this.socket.on('close', () => {
                this.connected = false;
            });
        });
    }

    _processBuffer(connectResolve) {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line) continue;

            // C-Gate service ready line (e.g., "201 Service ready: C-Gate...")
            if (line.startsWith('201 ') && connectResolve) {
                const resolve = connectResolve;
                connectResolve = null;
                resolve(line);
                continue;
            }

            if (this.responseResolve) {
                const resolve = this.responseResolve;
                this.responseResolve = null;
                this.responseReject = null;
                if (this.responseTimeout) {
                    clearTimeout(this.responseTimeout);
                    this.responseTimeout = null;
                }
                resolve(line);
            }
        }
    }

    sendCommand(cmd) {
        return new Promise((resolve, reject) => {
            if (!this.connected || !this.socket) {
                return reject(new Error('Not connected'));
            }

            this.responseResolve = resolve;
            this.responseReject = reject;
            this.responseTimeout = setTimeout(() => {
                this.responseResolve = null;
                this.responseReject = null;
                reject(new Error(`Timeout waiting for response to: ${cmd}`));
            }, RESPONSE_TIMEOUT_MS);

            this.socket.write(cmd + '\n');
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
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

async function doExport(client, args) {
    const { project, network, app } = args;

    console.log(`\nExporting labels from //${project}/${network}/${app} ...\n`);

    // First, discover all groups via TREEXML
    const treeResponse = await client.sendCommand(`TREEXML //${project}/${network}/${app}`);
    const groups = [];

    if (treeResponse.startsWith('347-')) {
        // Multi-line TREEXML response — collect all the XML
        let xml = treeResponse.substring(4) + '\n';
        // Keep reading lines until we get the 347 terminator
        while (true) {
            const line = await client.sendCommand('');  // read next buffered line
            if (line.startsWith('347 ')) {
                break;
            }
            xml += line.startsWith('347-') ? line.substring(4) + '\n' : line + '\n';
        }
        // Parse group addresses from XML
        const groupRegex = /<Group>.*?<Address>(\d+)<\/Address>.*?<TagName>([^<]*)<\/TagName>.*?<\/Group>/gs;
        let match;
        while ((match = groupRegex.exec(xml)) !== null) {
            groups.push({ address: match[1], label: match[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
        }
        // Also try with TagName before Address
        const groupRegex2 = /<Group>.*?<TagName>([^<]*)<\/TagName>.*?<Address>(\d+)<\/Address>.*?<\/Group>/gs;
        while ((match = groupRegex2.exec(xml)) !== null) {
            const addr = match[2];
            if (!groups.find(g => g.address === addr)) {
                groups.push({ address: addr, label: match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
            }
        }
    }

    if (groups.length === 0) {
        // Fallback: try DBGET on a range of known addresses
        console.log('TREEXML did not return parseable groups. Falling back to DBGET scan...');
        for (let addr = 0; addr <= 255; addr++) {
            const objPath = cgateObjectPath(project, network, app, addr);
            try {
                const resp = await client.sendCommand(`DBGET ${objPath} TagName`);
                if (resp.startsWith('300 ')) {
                    const tagMatch = resp.match(/TagName="([^"]*)"/);
                    if (tagMatch && tagMatch[1] !== '<Unused>') {
                        groups.push({ address: String(addr), label: tagMatch[1] });
                    }
                }
            } catch (_) { /* skip timeouts for non-existent groups */ }
            if (addr % 50 === 0 && addr > 0) {
                process.stdout.write(`  scanned ${addr}/255 addresses...\r`);
            }
            await sleep(args.delay / 2);
        }
        console.log('');
    }

    groups.sort((a, b) => parseInt(a.address) - parseInt(b.address));

    console.log(`Found ${groups.length} groups:\n`);
    const maxAddr = Math.max(...groups.map(g => g.address.length));
    for (const g of groups) {
        console.log(`  ${g.address.padStart(maxAddr)} : ${g.label}`);
    }

    const outputFile = args.output || `cbus-labels-backup-${new Date().toISOString().split('T')[0]}.json`;
    const outputData = {
        exported: new Date().toISOString(),
        project,
        network,
        application: app,
        groups
    };
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2) + '\n', 'utf8');
    console.log(`\nBackup saved to ${outputFile}`);
    return groups;
}

async function doApply(client, args) {
    const renameMap = loadRenameMap(args.renameFile);
    const { project, network, app } = {
        project: renameMap.project || args.project,
        network: renameMap.network || args.network,
        app: renameMap.application || args.app
    };

    const renames = Object.entries(renameMap.renames);
    const deletes = renameMap.delete || [];

    console.log(`\n${args.dryRun ? '[DRY RUN] ' : ''}Applying ${renames.length} renames and ${deletes.length} deletes to //${project}/${network}/${app}\n`);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const [addr, newLabel] of renames) {
        const objPath = cgateObjectPath(project, network, app, addr);
        const cmd = `DBSET ${objPath} TagName "${newLabel}"`;

        if (args.dryRun) {
            console.log(`  [DRY RUN] ${cmd}`);
            skipped++;
            continue;
        }

        try {
            const resp = await client.sendCommand(cmd);
            if (resp.startsWith('200 ')) {
                console.log(`  OK  ${addr.padStart(3)} -> "${newLabel}"`);
                success++;
            } else {
                console.log(`  ERR ${addr.padStart(3)} -> "${newLabel}" : ${resp}`);
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
        const cmd = `DBSET ${objPath} TagName "<Unused>"`;

        if (args.dryRun) {
            console.log(`  [DRY RUN] ${cmd}`);
            skipped++;
            continue;
        }

        try {
            const resp = await client.sendCommand(cmd);
            if (resp.startsWith('200 ')) {
                console.log(`  OK  ${String(addr).padStart(3)} -> <Unused> (deleted)`);
                success++;
            } else {
                console.log(`  ERR ${String(addr).padStart(3)} -> delete : ${resp}`);
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
    const { project, network, app } = {
        project: renameMap.project || args.project,
        network: renameMap.network || args.network,
        app: renameMap.application || args.app
    };

    const renames = Object.entries(renameMap.renames);
    console.log(`\nVerifying ${renames.length} labels on //${project}/${network}/${app} ...\n`);

    let matched = 0;
    let mismatched = 0;
    let errors = 0;

    for (const [addr, expected] of renames) {
        const objPath = cgateObjectPath(project, network, app, addr);
        try {
            const resp = await client.sendCommand(`DBGET ${objPath} TagName`);
            if (resp.startsWith('300 ')) {
                const tagMatch = resp.match(/TagName="([^"]*)"/);
                const actual = tagMatch ? tagMatch[1] : '(parse error)';
                if (actual === expected) {
                    matched++;
                } else {
                    console.log(`  MISMATCH ${addr.padStart(3)}: expected "${expected}" got "${actual}"`);
                    mismatched++;
                }
            } else {
                console.log(`  ERROR    ${addr.padStart(3)}: ${resp}`);
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

    if (args.dryRun && args.mode !== 'apply') {
        console.error('Error: --dry-run can only be used with --apply.\n');
        process.exit(1);
    }

    if (args.dryRun) {
        console.log('=== DRY RUN MODE - No changes will be made ===\n');
        const renameMap = loadRenameMap(args.renameFile);
        const { project, network, app } = {
            project: renameMap.project || args.project,
            network: renameMap.network || args.network,
            app: renameMap.application || args.app
        };

        const renames = Object.entries(renameMap.renames);
        const deletes = renameMap.delete || [];

        console.log(`Target: //${project}/${network}/${app}`);
        console.log(`Renames: ${renames.length}, Deletes: ${deletes.length}\n`);

        for (const [addr, newLabel] of renames) {
            const objPath = cgateObjectPath(project, network, app, addr);
            console.log(`DBSET ${objPath} TagName "${newLabel}"`);
        }
        for (const addr of deletes) {
            const objPath = cgateObjectPath(project, network, app, addr);
            console.log(`DBSET ${objPath} TagName "<Unused>"`);
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
