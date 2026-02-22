#!/usr/bin/env node

/**
 * CLI tool to import C-Bus group labels from Clipsal Toolkit project files.
 *
 * Supports:
 *   - CBZ files (ZIP archive from C-Bus Toolkit export)
 *   - Raw XML files (C-Gate tag database or DBGETXML output)
 *
 * Usage:
 *   node tools/import-cbus-labels.js <input-file> [options]
 *
 * Options:
 *   --output, -o <path>    Output JSON file path (default: labels.json)
 *   --network, -n <id>     Filter to a specific network address
 *   --merge, -m            Merge with existing output file instead of replacing
 *   --help, -h             Show help
 */

const fs = require('fs');
const path = require('path');
const CbusProjectParser = require('../src/cbusProjectParser');

function parseArgs(argv) {
    const args = { inputFile: null, output: 'labels.json', network: null, merge: false };
    const positional = [];

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (arg === '--output' || arg === '-o') {
            args.output = argv[++i];
        } else if (arg === '--network' || arg === '-n') {
            args.network = argv[++i];
        } else if (arg === '--merge' || arg === '-m') {
            args.merge = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        } else {
            console.error(`Unknown option: ${arg}`);
            printUsage();
            process.exit(1);
        }
    }

    args.inputFile = positional[0] || null;
    return args;
}

function printUsage() {
    console.log(`
Usage: node tools/import-cbus-labels.js <input-file> [options]

Import C-Bus group labels from a Clipsal Toolkit project file (CBZ or XML)
and generate a JSON label file for use with cgateweb's HA Discovery.

Arguments:
  <input-file>           Path to a .cbz or .xml file from C-Bus Toolkit

Options:
  --output, -o <path>    Output JSON file path (default: labels.json)
  --network, -n <id>     Filter to a specific C-Bus network address
  --merge, -m            Merge with existing output file instead of replacing
  --help, -h             Show this help message

Examples:
  node tools/import-cbus-labels.js project.cbz
  node tools/import-cbus-labels.js project.cbz -o config/labels.json -n 254
  node tools/import-cbus-labels.js tag-db.xml --merge
`.trim());
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.inputFile) {
        console.error('Error: No input file specified.\n');
        printUsage();
        process.exit(1);
    }

    const inputPath = path.resolve(args.inputFile);
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
    }

    console.log(`Reading ${inputPath}...`);
    const buffer = fs.readFileSync(inputPath);
    const filename = path.basename(inputPath);

    const parser = new CbusProjectParser();
    const options = {};
    if (args.network) options.network = args.network;

    let result;
    try {
        result = await parser.parse(buffer, filename, options);
    } catch (err) {
        console.error(`Error parsing file: ${err.message}`);
        process.exit(1);
    }

    console.log(`Found ${result.stats.networkCount} network(s), ${result.stats.groupCount} group(s), ${result.stats.labelCount} label(s)`);

    if (result.networks.length > 0) {
        console.log('Networks:');
        for (const net of result.networks) {
            console.log(`  ${net.address}: ${net.name || '(unnamed)'}`);
        }
    }

    let labels = result.labels;

    if (args.merge && fs.existsSync(args.output)) {
        console.log(`Merging with existing file: ${args.output}`);
        try {
            const existing = JSON.parse(fs.readFileSync(args.output, 'utf8'));
            labels = { ...existing.labels, ...result.labels };
        } catch (err) {
            console.warn(`Warning: Could not read existing file for merge: ${err.message}`);
        }
    }

    const outputData = {
        version: 1,
        source: filename,
        generated: new Date().toISOString(),
        labels
    };

    const outputPath = path.resolve(args.output);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2) + '\n', 'utf8');
    console.log(`\nWrote ${Object.keys(labels).length} labels to ${outputPath}`);
    console.log('\nTo use with cgateweb, add to your settings.js:');
    console.log(`  exports.cbus_label_file = '${path.relative(process.cwd(), outputPath) || outputPath}';`);
}

main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
