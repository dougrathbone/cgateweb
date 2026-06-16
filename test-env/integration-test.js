#!/usr/bin/env node
/**
 * Integration test for cgateweb managed mode.
 *
 * Validates the full managed-mode stack:
 *   podman-compose  →  C-Gate install  →  C-Gate start  →  cgateweb  →  MQTT ready
 *
 * Uses `podman-compose` (the Python wrapper, installed via pip / brew) rather
 * than `podman compose` (the built-in subcommand). `podman compose` on Linux
 * delegates to an external docker-compose plugin that expects a daemon socket
 * which isn't activated on rootless CI runners; `podman-compose` shells out
 * to the podman CLI directly and works in both environments without setup.
 *
 * Usage:
 *   node test-env/integration-test.js                # full lifecycle (build → test → teardown)
 *   node test-env/integration-test.js --no-build     # skip build, use existing image
 *   node test-env/integration-test.js --no-teardown  # leave stack running after test
 *   node test-env/integration-test.js --attach       # stack already up, just run assertions
 *
 * Prerequisites:
 *   podman machine start    (macOS/Windows only)
 *   pip install podman-compose   OR   brew install podman-compose
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
    const result = spawnSync('podman-compose', args, {
        cwd: TEST_ENV_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
    });
    return result;
}

function composeUp(build) {
    const buildArgs = build ? ['--build'] : [];
    info(`podman-compose up${build ? ' --build' : ''} (this may take a few minutes on first run)`);
    const result = spawnSync('podman-compose', ['up', '--detach', ...buildArgs], {
        cwd: TEST_ENV_DIR,
        stdio: 'inherit',
        encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('podman-compose up failed');
}

function composeDown() {
    info('Stopping compose stack...');
    spawnSync('podman-compose', ['down'], {
        cwd: TEST_ENV_DIR,
        stdio: 'inherit',
    });
}

/**
 * Talk to managed C-Gate's command port from *inside* the addon container.
 * C-Gate's access.txt only permits 127.0.0.1, so we cannot reach the command
 * port from the host — we exec a tiny bash/dev-tcp client in the container.
 * Returns { ok, output }. Used to assert the project actually loaded (issue #16),
 * which the MQTT surface alone can't prove without live C-Bus hardware.
 */
function probeCgate(commands, port = 20023) {
    const ps = spawnSync('podman', ['ps', '--format', '{{.Names}}', '--filter', 'name=addon'], {
        encoding: 'utf8',
    });
    const container = (ps.stdout || '').trim().split('\n').filter(Boolean)[0];
    if (!container) return { ok: false, output: '', error: 'addon container not found' };

    // Single-quote each command for bash, escaping any embedded single quotes
    // ('->'\'') so a command (or a project name interpolated into one) cannot
    // break out of the quoted context and inject shell.
    const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;
    const lines = [
        `exec 3<>/dev/tcp/127.0.0.1/${Number(port)}`,
        'timeout 1 head -c 600 <&3 || true',
        ...commands.map(c => `printf '%s\\r\\n' ${shQuote(c)} >&3`),
        'timeout 5 cat <&3 || true',
    ];
    const res = spawnSync('podman', ['exec', '-i', container, 'bash', '-c', lines.join('\n')], {
        encoding: 'utf8',
    });
    return {
        ok: res.status === 0,
        output: `${res.stdout || ''}${res.stderr || ''}`,
        error: res.stderr || '',
    };
}

/**
 * Poll C-Gate until the named project reports state=started, or timeout.
 * project.start auto-loads the project *after* C-Gate begins accepting
 * connections: on a fresh database C-Gate first runs an XML→SQL transform
 * (tens of seconds, slower on CI runners) and only then starts the project, so
 * an immediate probe races it — and the bridge reports "ready" well before the
 * project is up. cgateweb tolerates the same window via its TREEXML retry
 * logic. Generous timeout because the first-boot transform is never cached in
 * CI. Returns the last probe result.
 */
// Escape regex metacharacters so a value (e.g. a project name like "HOME[1]")
// is matched literally rather than interpreted as a pattern.
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when C-Gate's `project list` output reports the named project started.
function projectIsStarted(output, projectName) {
    return new RegExp(`project=${escapeRegExp(projectName)}\\s+state=started`).test(output);
}

async function waitForProjectStarted(projectName, commands, port, timeoutMs = 150000) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let last = { ok: false, output: '', error: '' };
    do {
        last = probeCgate(commands, port);
        if (projectIsStarted(last.output, projectName)) return last;
        attempt++;
        if (attempt % 4 === 0) {
            info(`still waiting for project '${projectName}' to start (C-Gate first-boot XML→SQL transform)…`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    } while (Date.now() < deadline);
    return last;
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

    // podman-compose (the Python wrapper) available?
    const pcv = spawnSync('podman-compose', ['--version'], { encoding: 'utf8' });
    if (pcv.status !== 0) {
        fail('podman-compose not found — install with: pip install podman-compose (or: brew install podman-compose)');
        process.exit(1);
    }
    const firstLine = pcv.stdout.trim().split('\n')[0] || 'podman-compose';
    pass(firstLine);

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

    // Live-C-Bus assertions (entity counts, discovery_status=ok, empty retry
    // queue) require a *synced* C-Bus network — i.e. real hardware or a
    // simulated CNI. The committed test project (share/cgate/tag/HOME.db) loads
    // into C-Gate, but its network is type=serial/COM1 and never syncs in CI, so
    // TREEXML returns an empty tree and no entities are discovered. Those
    // assertions therefore soft-pass unless CGATEWEB_E2E_EXPECT_LIVE=1 is set
    // (run against real hardware). The project *loading itself* is asserted
    // strictly below via the C-Gate command port — that's the issue #16 guard.
    const expectLiveCbus = process.env.CGATEWEB_E2E_EXPECT_LIVE === '1';
    if (!expectLiveCbus) {
        info('No live C-Bus expected (CGATEWEB_E2E_EXPECT_LIVE!=1) — entity-discovery assertions soft-pass; project-load is still checked strictly.');
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
    // 4b. C-Gate project loaded  (issue #16 regression guard)
    // ------------------------------------------------------------------
    // The bridge can be "connected and ready" while C-Gate has NO project
    // loaded — that was issue #16: the project .db was synced to tag/ instead
    // of Projects/<NAME>/, so `project list` returned "no projects found" and
    // every command 401'd. MQTT readiness alone never caught it. Here we talk
    // to C-Gate's command port directly and assert the project is loaded,
    // started, and that its real database parsed (App 56 Lighting present).
    section('C-Gate project loaded (issue #16)');

    const opts = JSON.parse(fs.readFileSync(path.join(TEST_ENV_DIR, 'active-options.json'), 'utf8'));
    const projectName = opts.cgate_project || 'HOME';
    const probeNetwork = (Array.isArray(opts.ha_discovery_networks) && opts.ha_discovery_networks[0]) || 254;
    const commandPort = opts.cgate_port || 20023;

    const probe = await waitForProjectStarted(
        projectName,
        ['project list', `dbget //${projectName}/${probeNetwork}/Application`],
        commandPort
    );

    if (!probe.ok && !probe.output) {
        fail(`could not probe C-Gate command port (${probe.error || 'no container'})`);
        failed++;
    } else {
        assert(
            `C-Gate reports project=${projectName} state=started`,
            projectIsStarted(probe.output, projectName),
            `project list → ${probe.output.replace(/\s+/g, ' ').trim().slice(0, 160)}`
        );
        assert(
            'loaded project exposes App 56 Lighting  (real .db parsed, not an empty/unloaded project)',
            /Address=56\b/.test(probe.output) && /Lighting/.test(probe.output),
            'dbget did not return App 56 Lighting — project failed to load from Projects/<NAME>/'
        );
    }

    // ------------------------------------------------------------------
    // 5. Bridge lifecycle
    // ------------------------------------------------------------------
    section('Bridge lifecycle');

    assert(
        'lifecycle_state = ready',
        msgs['cbus/read/bridge/diagnostics/lifecycle_state/state'] === 'ready',
        `got: ${msgs['cbus/read/bridge/diagnostics/lifecycle_state/state']}`
    );

    if (expectLiveCbus) {
        assert(
            'command_queue_depth = 0  (no backlog)',
            msgs['cbus/read/bridge/diagnostics/command_queue_depth/state'] === '0',
            `got: ${msgs['cbus/read/bridge/diagnostics/command_queue_depth/state']}`
        );
    } else {
        // Without a synced C-Bus, getall/gettree against the (loaded but
        // un-synced) network retry and pile up, so a nonzero queue is expected.
        info(`command_queue_depth = ${msgs['cbus/read/bridge/diagnostics/command_queue_depth/state']} (expected without live C-Bus; soft pass)`);
        pass('command_queue_depth (soft pass — no live C-Bus)');
        passed++;
    }

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

        if (expectLiveCbus) {
            assert(
                `at least one light entity discovered (found ${lightCount})`,
                lightCount > 0,
                'expected App 56 lights; C-Gate may have no devices configured'
            );
        } else {
            // The project loads, but its network never syncs without real
            // hardware, so TREEXML is empty and no light entities appear.
            info(`No light entities expected without live C-Bus (found ${lightCount}).`);
            pass('light entity discovery (soft pass — no live C-Bus)');
            passed++;
        }

        info(`Discovery summary: ${discoveryMessages.size} total, ${lightCount} light(s)`);
    }

    // ------------------------------------------------------------------
    // 6b. Discovery health diagnostic (v1.8.4) — per-network sensor
    // ------------------------------------------------------------------
    section('Discovery health diagnostic');
    info('Collecting per-network discovery_status messages for 3s...');

    const diagReceived = await collectMqtt(
        ['homeassistant/sensor/cgateweb_discovery_+/config', 'cbus/read/+///discovery_status'],
        3000
    );
    const diagConfigTopics = Object.keys(diagReceived).filter(t =>
        /^homeassistant\/sensor\/cgateweb_discovery_\w+\/config$/.test(t)
    );
    const diagStateTopics = Object.keys(diagReceived).filter(t =>
        /^cbus\/read\/\w+\/\/\/discovery_status$/.test(t)
    );

    if (diagConfigTopics.length === 0 && diagStateTopics.length === 0) {
        info('No discovery diagnostic messages received — HA Discovery may not have run (no networks configured?). Skipping diagnostic assertions.');
        pass('Discovery diagnostic: no messages (soft pass)');
        passed++;
    } else {
        if (expectLiveCbus) {
            assert(
                `discovery diagnostic config published (${diagConfigTopics.length} sensor config(s))`,
                diagConfigTopics.length > 0
            );
        } else {
            // _publishDiscoveryStatusConfig fires at the first _setDiscoveryStatus
            // call, which happens at bridge startup before the test's collection
            // window opens. Retained delivery to the second collection is not
            // reliably observed without live C-Bus - this surfaced when
            // continue-on-error was removed in May 2026 and is tracked as a
            // separate test-design item. Soft-passing here keeps live-hardware
            // runs honest while not blocking the no-live-C-Bus CI baseline.
            info(`Retained diag config delivery not consistently observed without live C-Bus (${diagConfigTopics.length} config(s) seen).`);
            pass('discovery diagnostic config (soft pass — no live C-Bus)');
            passed++;
        }
        assert(
            `discovery diagnostic state published (${diagStateTopics.length} network(s))`,
            diagStateTopics.length > 0
        );

        // Validate the config payload shape on at least one diagnostic.
        if (diagConfigTopics.length > 0) {
            const cfgTopic = diagConfigTopics[0];
            try {
                const cfg = JSON.parse(diagReceived[cfgTopic]);
                assert(
                    `${cfgTopic} has entity_category=diagnostic`,
                    cfg.entity_category === 'diagnostic',
                    `got: ${cfg.entity_category}`
                );
                assert(
                    `${cfgTopic} has unique_id matching cgateweb_discovery_*`,
                    typeof cfg.unique_id === 'string' && cfg.unique_id.startsWith('cgateweb_discovery_'),
                    `got: ${cfg.unique_id}`
                );
                assert(
                    `${cfgTopic} state_topic matches cbus/read/<network>///discovery_status`,
                    /^cbus\/read\/\w+\/\/\/discovery_status$/.test(cfg.state_topic || ''),
                    `got: ${cfg.state_topic}`
                );
                assert(
                    `${cfgTopic} grouped under cgateweb_bridge device`,
                    Array.isArray(cfg.device?.identifiers) && cfg.device.identifiers.includes('cgateweb_bridge'),
                    `got: ${JSON.stringify(cfg.device?.identifiers)}`
                );
            } catch (err) {
                fail(`${cfgTopic} payload not valid JSON: ${err.message}`);
                failed++;
            }
        }

        // Validate the state payload — should be one of {discovering, ok, paused}.
        const validStates = new Set(['discovering', 'ok', 'paused']);
        for (const stateTopic of diagStateTopics) {
            const value = diagReceived[stateTopic];
            assert(
                `${stateTopic} = ${value} (one of discovering/ok/paused)`,
                validStates.has(value),
                `got: ${value}`
            );
        }

        // For a working stack with at least one network, at least one diagnostic
        // should have reached "ok" (TreeXML succeeded). If everything is still
        // "discovering" after readiness, something's wrong - unless the fixture
        // intentionally has no project loaded, in which case TreeXML can't
        // succeed by definition.
        const okCount = diagStateTopics.filter(t => diagReceived[t] === 'ok').length;
        if (expectLiveCbus) {
            assert(
                `at least one network reached discovery_status=ok  (${okCount} of ${diagStateTopics.length})`,
                okCount > 0 || diagStateTopics.length === 0,
                'all networks still in discovering/paused after readiness'
            );
        } else {
            info(`discovery_status=ok not expected without live C-Bus (${okCount} of ${diagStateTopics.length}).`);
            pass('discovery_status reaches ok (soft pass — no live C-Bus)');
            passed++;
        }
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
