#!/usr/bin/env node
/**
 * Integration test for cgateweb managed mode.
 *
 * Validates the full managed-mode stack:
 *   podman compose  →  C-Gate install  →  C-Gate start  →  cgateweb  →  MQTT ready
 *
 * Usage:
 *   node test-env/integration-test.js                # full lifecycle (build → test → teardown)
 *   node test-env/integration-test.js --no-build     # skip build, use existing image
 *   node test-env/integration-test.js --no-teardown  # leave stack running after test
 *   node test-env/integration-test.js --attach       # stack already up, just run assertions
 *
 * Prerequisites:
 *   podman machine start
 *   cp test-env/options-managed-download.json test-env/active-options.json
 */

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mqtt = require('../node_modules/mqtt');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_ENV_DIR   = path.resolve(__dirname);
const CGATE_JAR      = path.join(TEST_ENV_DIR, 'volumes/data/cgate/cgate.jar');
const MQTT_URL       = 'mqtt://localhost:1883';
const READY_TIMEOUT  = 3 * 60 * 1000;   // 3 min — covers first-time C-Gate download
const STABLE_WINDOW  = 10 * 1000;        // 10 s stability check after ready

const args           = new Set(process.argv.slice(2));
const OPT_NO_BUILD   = args.has('--no-build');
const OPT_NO_TEAR    = args.has('--no-teardown');
const OPT_ATTACH     = args.has('--attach');   // stack is already running

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function log(msg)    { process.stdout.write(`${msg}\n`); }
function info(msg)   { log(`  ${DIM}${msg}${RESET}`); }
function pass(label) { log(`  ${GREEN}✔${RESET}  ${label}`); }
function fail(label) { log(`  ${RED}✘${RESET}  ${label}`); }
function section(h)  { log(`\n${BOLD}${h}${RESET}`); }

function compose(...args) {
    const result = spawnSync('podman', ['compose', ...args], {
        cwd: TEST_ENV_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
    });
    return result;
}

function composeUp(build) {
    const buildArgs = build ? ['--build'] : [];
    info(`podman compose up${build ? ' --build' : ''} (this may take a few minutes on first run)`);
    const result = spawnSync('podman', ['compose', 'up', '--detach', ...buildArgs], {
        cwd: TEST_ENV_DIR,
        stdio: 'inherit',
        encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('podman compose up failed');
}

function composeDown() {
    info('Stopping compose stack...');
    spawnSync('podman', ['compose', 'down'], {
        cwd: TEST_ENV_DIR,
        stdio: 'inherit',
    });
}

function checkPrereqs() {
    section('Prerequisites');

    // podman available?
    const pv = spawnSync('podman', ['--version'], { encoding: 'utf8' });
    if (pv.status !== 0) {
        fail('podman not found — install with: brew install podman podman-compose');
        process.exit(1);
    }
    pass(`podman ${pv.stdout.trim().split('\n')[0]}`);

    // podman machine running? (macOS/Windows only — Linux runs containers natively)
    if (process.platform !== 'linux') {
        const pm = spawnSync('podman', ['machine', 'list', '--format', '{{.Running}}'], { encoding: 'utf8' });
        if (!pm.stdout.includes('true')) {
            fail('podman machine not running - start with: podman machine start');
            process.exit(1);
        }
        pass('podman machine running');
    } else {
        pass('podman machine not required on Linux (native containers)');
    }

    // active-options.json present?
    const optFile = path.join(TEST_ENV_DIR, 'active-options.json');
    if (!fs.existsSync(optFile)) {
        fail(`active-options.json not found. Create it:
       cp test-env/options-managed-download.json test-env/active-options.json`);
        process.exit(1);
    }
    const opts = JSON.parse(fs.readFileSync(optFile, 'utf8'));
    pass(`active-options.json (cgate_mode=${opts.cgate_mode})`);

    if (opts.cgate_mode !== 'managed') {
        fail('active-options.json must have cgate_mode=managed for this test');
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// MQTT assertion engine
// ---------------------------------------------------------------------------

/**
 * Subscribes to a set of topics and waits until a predicate is satisfied or
 * timeout is reached. Returns the collected message map.
 */
function waitForMqtt(topicPatterns, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const received = {};
        const client = mqtt.connect(MQTT_URL, { clientId: 'integration-test' });

        const timer = setTimeout(() => {
            client.end(true);
            reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for MQTT readiness`));
        }, timeoutMs);

        client.on('error', err => {
            clearTimeout(timer);
            client.end(true);
            reject(new Error(`MQTT connection error: ${err.message}`));
        });

        client.on('connect', () => {
            topicPatterns.forEach(t => client.subscribe(t));
        });

        client.on('message', (topic, payload) => {
            received[topic] = payload.toString();
            if (predicate(received)) {
                clearTimeout(timer);
                client.end(false, {}, () => resolve(received));
            }
        });
    });
}

/**
 * Collect MQTT messages for `durationMs` ms. Used for the stability window.
 */
function collectMqtt(topicPatterns, durationMs) {
    return new Promise((resolve, reject) => {
        const received = {};
        const client = mqtt.connect(MQTT_URL, { clientId: 'integration-test-stable' });

        const timer = setTimeout(() => {
            client.end(true);
            resolve(received);
        }, durationMs);

        client.on('error', err => {
            clearTimeout(timer);
            client.end(true);
            reject(new Error(`MQTT connection error: ${err.message}`));
        });

        client.on('connect', () => {
            topicPatterns.forEach(t => client.subscribe(t));
        });

        client.on('message', (topic, payload) => {
            received[topic] = payload.toString();
        });
    });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function runTests() {
    let passed = 0;
    let failed = 0;

    function assert(label, condition, detail = '') {
        if (condition) {
            pass(label);
            passed++;
        } else {
            fail(`${label}${detail ? `  →  ${DIM}${detail}${RESET}` : ''}`);
            failed++;
        }
    }

    // ------------------------------------------------------------------
    // 1. Readiness: wait for bridge to report fully operational
    // ------------------------------------------------------------------
    section('Waiting for bridge readiness');

    const cgatePreviouslyInstalled = fs.existsSync(CGATE_JAR);
    if (cgatePreviouslyInstalled) {
        info('C-Gate already installed — skipping download wait');
    } else {
        info('C-Gate not yet installed — waiting for download + install...');
    }

    const READINESS_TOPICS = [
        'hello/cgateweb',
        'cbus/read/bridge/diagnostics/+/state',
    ];

    function isReady(msgs) {
        return (
            msgs['hello/cgateweb'] === 'Online' &&
            msgs['cbus/read/bridge/diagnostics/lifecycle_state/state'] === 'ready' &&
            msgs['cbus/read/bridge/diagnostics/mqtt_connected/state'] === 'ON' &&
            msgs['cbus/read/bridge/diagnostics/event_connected/state'] === 'ON' &&
            parseInt(msgs['cbus/read/bridge/diagnostics/command_pool_healthy/state'] || '0', 10) > 0
        );
    }

    let msgs;
    try {
        msgs = await waitForMqtt(READINESS_TOPICS, isReady, READY_TIMEOUT);
        info(`Bridge reached ready state`);
    } catch (err) {
        fail(`Bridge did not become ready within ${READY_TIMEOUT / 1000}s: ${err.message}`);
        return { passed, failed: failed + 1 };
    }

    // ------------------------------------------------------------------
    // 2. Installation assertions
    // ------------------------------------------------------------------
    section('C-Gate installation');

    assert(
        'C-Gate jar exists on disk',
        fs.existsSync(CGATE_JAR),
        CGATE_JAR
    );

    // ------------------------------------------------------------------
    // 3. MQTT connectivity assertions
    // ------------------------------------------------------------------
    section('MQTT connectivity');

    assert(
        'hello/cgateweb = Online',
        msgs['hello/cgateweb'] === 'Online',
        `got: ${msgs['hello/cgateweb']}`
    );

    assert(
        'mqtt_connected = ON',
        msgs['cbus/read/bridge/diagnostics/mqtt_connected/state'] === 'ON',
        `got: ${msgs['cbus/read/bridge/diagnostics/mqtt_connected/state']}`
    );

    // ------------------------------------------------------------------
    // 4. C-Gate connectivity assertions
    // ------------------------------------------------------------------
    section('C-Gate connectivity');

    assert(
        'event_connected = ON  (C-Gate event port 20025)',
        msgs['cbus/read/bridge/diagnostics/event_connected/state'] === 'ON',
        `got: ${msgs['cbus/read/bridge/diagnostics/event_connected/state']}`
    );

    const poolHealthy = parseInt(
        msgs['cbus/read/bridge/diagnostics/command_pool_healthy/state'] || '0', 10
    );
    assert(
        `command_pool_healthy > 0  (${poolHealthy} healthy connection(s))`,
        poolHealthy > 0,
        `got: ${poolHealthy}`
    );

    // ------------------------------------------------------------------
    // 5. Bridge lifecycle
    // ------------------------------------------------------------------
    section('Bridge lifecycle');

    assert(
        'lifecycle_state = ready',
        msgs['cbus/read/bridge/diagnostics/lifecycle_state/state'] === 'ready',
        `got: ${msgs['cbus/read/bridge/diagnostics/lifecycle_state/state']}`
    );

    assert(
        'command_queue_depth = 0  (no backlog)',
        msgs['cbus/read/bridge/diagnostics/command_queue_depth/state'] === '0',
        `got: ${msgs['cbus/read/bridge/diagnostics/command_queue_depth/state']}`
    );

    // ------------------------------------------------------------------
    // 6. HA MQTT Discovery validation
    // ------------------------------------------------------------------
    section('HA MQTT Discovery');
    info('Collecting discovery messages for 5s...');

    const discoveryMessages = new Map(); // topic → parsed payload

    const discoveryReceived = await collectMqtt(['homeassistant/#'], 5000);
    for (const [topic, payloadStr] of Object.entries(discoveryReceived)) {
        if (topic.startsWith('homeassistant/')) {
            try {
                discoveryMessages.set(topic, JSON.parse(payloadStr));
            } catch {
                // ignore non-JSON (e.g. empty retained cleanup payloads)
            }
        }
    }

    if (discoveryMessages.size === 0) {
        info('No HA discovery messages received — C-Gate may have no devices configured (fresh install). Skipping format assertions.');
        pass('HA discovery: no messages (soft pass — fresh C-Gate)');
        passed++;
    } else {
        info(`Received ${discoveryMessages.size} discovery message(s). Validating format...`);

        let lightCount = 0;
        let formatErrors = 0;

        for (const [topic, payload] of discoveryMessages) {
            // Required fields present in every discovery payload
            const hasUniqueId = 'unique_id' in payload;
            const hasName    = 'name' in payload;   // value may be null — that is valid
            const hasDevice  = payload.device && typeof payload.device === 'object';

            if (!hasUniqueId || !hasName || !hasDevice) {
                fail(`Discovery payload missing required fields on ${topic}  →  unique_id:${hasUniqueId} name:${hasName} device:${hasDevice}`);
                formatErrors++;
                failed++;
                continue;
            }

            // Detect light entities (topic: homeassistant/light/<id>/config)
            const lightTopicMatch = topic.match(/^homeassistant\/light\/([^/]+)\/config$/);
            if (lightTopicMatch) {
                lightCount++;

                // Validate state_topic follows cbus/read/{network}/56/{group}/state
                const stateTopic = payload.state_topic || '';
                const stateTopicValid = /^cbus\/read\/\w+\/56\/\w+\/state$/.test(stateTopic);
                if (!stateTopicValid) {
                    fail(`Light entity ${lightTopicMatch[1]} has unexpected state_topic: ${stateTopic}`);
                    formatErrors++;
                    failed++;
                } else {
                    info(`  light ${lightTopicMatch[1]}: state_topic=${stateTopic}`);
                }
            }
        }

        assert(
            'all discovery payloads have required fields (unique_id, name, device)',
            formatErrors === 0,
            `${formatErrors} payload(s) failed format validation`
        );

        assert(
            `at least one light entity discovered (found ${lightCount})`,
            lightCount > 0,
            'expected App 56 lights; C-Gate may have no devices configured'
        );

        info(`Discovery summary: ${discoveryMessages.size} total, ${lightCount} light(s)`);
    }

    // ------------------------------------------------------------------
    // 7. Stability check — watch for 10s, no reconnects
    // ------------------------------------------------------------------
    section(`Stability check (${STABLE_WINDOW / 1000}s window)`);
    info('Monitoring for unexpected reconnections...');

    const stable = await collectMqtt(READINESS_TOPICS, STABLE_WINDOW);
    const reconnect = stable['cbus/read/bridge/diagnostics/reconnect_indicator/state'] || 'event:0,pool:0';

    assert(
        `no reconnections during stability window  (${reconnect})`,
        reconnect === 'event:0,pool:0',
        `got: ${reconnect}`
    );

    assert(
        'still Online after stability window',
        stable['hello/cgateweb'] === undefined || stable['hello/cgateweb'] === 'Online',
        `got: ${stable['hello/cgateweb']}`
    );

    assert(
        'lifecycle_state still ready after stability window',
        stable['cbus/read/bridge/diagnostics/lifecycle_state/state'] === undefined ||
        stable['cbus/read/bridge/diagnostics/lifecycle_state/state'] === 'ready',
        `got: ${stable['cbus/read/bridge/diagnostics/lifecycle_state/state']}`
    );

    return { passed, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    log(`\n${BOLD}cgateweb managed-mode integration test${RESET}`);
    log(`${'─'.repeat(45)}`);

    checkPrereqs();

    let stackStartedByUs = false;
    if (!OPT_ATTACH) {
        section('Starting compose stack');
        composeUp(!OPT_NO_BUILD);
        stackStartedByUs = true;
    } else {
        section('Attaching to running compose stack');
        info('Assuming stack is already up');
    }

    let result;
    try {
        result = await runTests();
    } finally {
        if (stackStartedByUs && !OPT_NO_TEAR) {
            section('Teardown');
            composeDown();
        } else if (OPT_NO_TEAR) {
            info('--no-teardown: leaving stack running');
        }
    }

    const { passed, failed } = result;
    const total = passed + failed;

    log(`\n${'─'.repeat(45)}`);
    if (failed === 0) {
        log(`${GREEN}${BOLD}All ${total} tests passed${RESET}`);
    } else {
        log(`${RED}${BOLD}${failed} of ${total} tests failed${RESET}`);
    }
    log('');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    log(`\n${RED}Unhandled error: ${err.message}${RESET}`);
    process.exit(1);
});
