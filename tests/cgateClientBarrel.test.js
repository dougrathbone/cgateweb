const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = require('../package.json');

const BARRELS = {
    'cgate-client': path.join(REPO_ROOT, 'src', 'cgate-client', 'index.js'),
    'cgate-client/project': path.join(REPO_ROOT, 'src', 'cgate-client', 'project.js')
};

/**
 * Require a module in a child process whose working directory contains no
 * settings.js, and report everything the require did to the outside world.
 *
 * The child is given a hard timeout: a module that registers a timer, socket
 * or other handle at load time keeps the event loop alive and the child never
 * exits, which surfaces here as a non-zero status.
 */
function requireInCleanChild(modulePath, { extraSource = '' } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-client-purity-'));
    try {
        // Sanity: the temp cwd must not contain anything a config loader could latch onto.
        expect(fs.readdirSync(cwd)).toEqual([]);

        const script = `require(${JSON.stringify(modulePath)});\n${extraSource}`;
        const result = spawnSync(process.execPath, ['-e', script], {
            cwd,
            encoding: 'utf8',
            timeout: 30000,
            env: { ...process.env, NODE_ENV: undefined }
        });
        return {
            status: result.status,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? ''
        };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

describe('cgate-client barrels are import-pure', () => {
    for (const [name, modulePath] of Object.entries(BARRELS)) {
        describe(name, () => {
            let result;

            beforeAll(() => {
                result = requireInCleanChild(modulePath);
            });

            it('exits cleanly when required from a directory with no settings.js', () => {
                expect(result.status).toBe(0);
            });

            it('writes nothing to stdout', () => {
                expect(result.stdout).toBe('');
            });

            it('writes nothing to stderr', () => {
                expect(result.stderr).toBe('');
            });
        });
    }

    it('does not load cgateweb config, MQTT or Home Assistant layers', () => {
        // Printing to stdout is fine here because the assertion is about the
        // module graph, not the silence; the silence is covered above.
        const { status, stdout, stderr } = requireInCleanChild(BARRELS['cgate-client'], {
            extraSource: 'process.stdout.write(JSON.stringify(Object.keys(require.cache)));'
        });

        expect(stderr).toBe('');
        expect(status).toBe(0);

        const loaded = JSON.parse(stdout).map((p) => path.relative(REPO_ROOT, p));
        const forbidden = loaded.filter((p) =>
            /(^|\/)settings\.js$/.test(p) ||
            /^src\/config\//.test(p) && !/validationRules\.js$/.test(p) ||
            /^src\/(mqttManager|mqttCommandRouter|cgateWebBridge|haDiscovery|webServer|labelLoader)\.js$/.test(p) ||
            /^node_modules\/(mqtt|sql\.js|adm-zip|xml2js)\//.test(p)
        );

        expect(forbidden).toEqual([]);
    });

    it('does not load the project parser dependencies from the transport barrel', () => {
        const { stdout } = requireInCleanChild(BARRELS['cgate-client'], {
            extraSource: 'process.stdout.write(JSON.stringify(Object.keys(require.cache)));'
        });

        const loaded = JSON.parse(stdout);
        expect(loaded.some((p) => p.includes('cbusProjectParser'))).toBe(false);
    });

    it('proves the purity check can fail (control: index.js is not import-pure)', () => {
        // index.js is cgateweb's application entry point: it loads settings and
        // logs. If this control ever went silent the purity assertions above
        // would be vacuous.
        const { stdout } = requireInCleanChild(path.join(REPO_ROOT, 'index.js'));
        expect(stdout).not.toBe('');
    });
});

describe('cgate-client public surface', () => {
    const EXPECTED_CLIENT_EXPORTS = [
        'CgateConnection',
        'CgateConnectionPool',
        'LineProcessor',
        'ThrottledQueue',
        'backoffDelay',
        'Logger',
        'createLogger',
        'CBusEvent',
        'getDecoder',
        'appEventLine',
        'temperatureDecoder',
        'airconDecoder',
        'measurementDecoder',
        'securityDecoder',
        'buildSecurityStatusRequest',
        'buildSecurityArmCommand',
        'buildSecurityEmulateKeypadCommand',
        'buildMeasurementDataCommand',
        'SecurityPanelState',
        'securityPanelConditions',
        'securityZoneLabelKey',
        'parseSecurityZoneLabelKey',
        'constants'
    ];

    const EXPECTED_PROTOCOL_CONSTANTS = [
        'DEFAULT_CBUS_APP_LIGHTING',
        'DEFAULT_CBUS_APP_TEMPERATURE',
        'DEFAULT_CBUS_APP_AIRCON',
        'DEFAULT_CBUS_APP_SECURITY',
        'DEFAULT_CBUS_APP_MEASUREMENT',
        'CGATE_LEVEL_MIN',
        'CGATE_LEVEL_MAX',
        'RAMP_STEP',
        'CGATE_CMD_ON',
        'CGATE_CMD_OFF',
        'CGATE_CMD_RAMP',
        'CGATE_CMD_TERMINATERAMP',
        'CGATE_CMD_GET',
        'CGATE_CMD_TREEXML',
        'CGATE_CMD_EVENT_MODE_L6',
        'CGATE_CMD_LOGIN',
        'CGATE_PARAM_LEVEL',
        'CGATE_RESPONSE_OBJECT_STATUS',
        'CGATE_RESPONSE_TREE_START',
        'CGATE_RESPONSE_TREE_END',
        'CGATE_RESPONSE_TREE_DATA',
        'CGATE_RESPONSE_SYSTEM_EVENT',
        'CGATE_RESPONSE_NETWORK_SYNC_OK',
        'NEWLINE',
        'EVENT_REGEX',
        'CGATE_EVENT_NETWORK_SYNC_REGEX'
    ];

    it('exports every documented client symbol as a defined value', () => {
        const client = require('../src/cgate-client');

        for (const name of EXPECTED_CLIENT_EXPORTS) {
            expect(client[name]).toBeDefined();
        }
        expect(Object.keys(client).sort()).toEqual([...EXPECTED_CLIENT_EXPORTS].sort());
    });

    it('exports every documented protocol constant as a defined value', () => {
        const { constants } = require('../src/cgate-client');

        for (const name of EXPECTED_PROTOCOL_CONSTANTS) {
            expect(constants[name]).toBeDefined();
        }
        expect(Object.keys(constants).sort()).toEqual([...EXPECTED_PROTOCOL_CONSTANTS].sort());
    });

    it('does not leak MQTT or Home Assistant vocabulary through the constants export', () => {
        const { constants } = require('../src/cgate-client');
        const leaked = Object.keys(constants).filter((k) => /^(MQTT_|HA_|DISCOVERY_STATE_)/.test(k));

        expect(leaked).toEqual([]);
    });

    it('exports the project parser from the project barrel', () => {
        const { CbusProjectParser } = require('../src/cgate-client/project');

        expect(typeof CbusProjectParser).toBe('function');
        expect(new CbusProjectParser()).toBeInstanceOf(CbusProjectParser);
    });

    it('re-exports the identical objects, not copies', () => {
        const client = require('../src/cgate-client');

        expect(client.CgateConnection).toBe(require('../src/cgateConnection'));
        expect(client.CBusEvent).toBe(require('../src/cbusEvent'));
        expect(client.backoffDelay).toBe(require('../src/backoff').backoffDelay);
        expect(require('../src/cgate-client/project').CbusProjectParser)
            .toBe(require('../src/cbusProjectParser'));
    });
});

describe('package.json library entry points', () => {
    it('declares main, exports and files', () => {
        expect(PACKAGE_JSON.main).toBe('./index.js');
        expect(PACKAGE_JSON.exports).toBeDefined();
        expect(PACKAGE_JSON.files).toEqual(expect.arrayContaining(['src/', 'index.js']));
    });

    it('resolves every path in the exports map', () => {
        const targets = Object.values(PACKAGE_JSON.exports);

        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(typeof target).toBe('string');
            expect(fs.existsSync(path.join(REPO_ROOT, target))).toBe(true);
        }
    });

    it('ships everything the exports map points at via the files list', () => {
        for (const target of Object.values(PACKAGE_JSON.exports)) {
            const relative = target.replace(/^\.\//, '');
            const covered = relative === 'package.json' ||
                PACKAGE_JSON.files.some((entry) =>
                    entry.endsWith('/') ? relative.startsWith(entry) : relative === entry);
            expect(covered).toBe(true);
        }
    });
});
