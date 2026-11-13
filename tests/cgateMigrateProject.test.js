const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');
const { BASHIO_STUB_WITH_LOGS } = require('./helpers/bashioStub');
const { addonBin, addonPath } = require('./helpers/addonPaths');

const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = addonBin('cgateweb-migrate-project');
const RUN_SCRIPT = addonPath('etc', 'services.d', 'cgateweb', 'run');

const SCHEMA_ERROR = '408 Operation failed: Project load failed: Error reading db file: Incompatible project: SchemaVersion is 13 and must be 14 - perform a TRANSFORM MIGRATE_SQL command to fix this';

// Reads the C-Gate command on stdin, records it, and answers from CGW_RESPONSES
// (one response per line of the file, consumed in order). A response of "-" is
// an empty reply.
const QUERY_STUB = `#!/usr/bin/env bash
cmd=$(cat)
printf '%s\\n' "$cmd" >> "$CGW_CMDS"
resp=$(head -n 1 "$CGW_RESPONSES")
if [[ -n "$resp" ]]; then
    tail -n +2 "$CGW_RESPONSES" > "$CGW_RESPONSES.next"
    mv "$CGW_RESPONSES.next" "$CGW_RESPONSES"
fi
if [[ "$resp" != "-" ]]; then
    printf '%s\\n' "$resp"
fi
exit 0
`;

function runMigrate({ config = {}, responses = [], extraEnv = {}, withDb = false, backupContents = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-migrate-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'cgate-query'), QUERY_STUB, { mode: 0o755 });
    const responsesFile = path.join(dir, 'responses.txt');
    fs.writeFileSync(responsesFile, responses.join('\n') + (responses.length ? '\n' : ''));
    const cgateDir = path.join(dir, 'cgate');
    if (withDb) {
        const projectDir = path.join(cgateDir, 'Projects', 'HOME');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'HOME.db'), 'original-database');
        if (backupContents !== null) {
            fs.writeFileSync(path.join(projectDir, 'HOME.db.before-schema-migrate'), backupContents);
        }
    }
    const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CGW_MIGRATE_SCRIPT: SCRIPT,
        CGW_CMDS: path.join(dir, 'cmds.txt'),
        CGW_RESPONSES: responsesFile,
        CGATEWEB_CGATE_QUERY: path.join(bin, 'cgate-query'),
        CGATE_DIR: cgateDir,
        CGATEWEB_MIGRATE_POLLS: '2',
        CGATEWEB_MIGRATE_POLL_INTERVAL: '0',
        ...extraEnv
    };
    for (const [key, value] of Object.entries(config)) {
        env[`CGW_TEST_${key}`] = value;
    }
    try {
        const output = execFileSync('bash', ['-c', `${BASHIO_STUB_WITH_LOGS}\nsource "$CGW_MIGRATE_SCRIPT"`], {
            encoding: 'utf8',
            env
        });
        return { status: 0, output, dir, cgateDir };
    } catch (error) {
        return {
            status: error.status,
            output: `${error.stdout || ''}${error.stderr || ''}`,
            dir,
            cgateDir
        };
    }
}

function commands(result) {
    const file = path.join(result.dir, 'cmds.txt');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function cleanup(result) {
    fs.rmSync(result.dir, { recursive: true, force: true });
}

describe('cgateweb service run', () => {
    test('migrates a too-old project before the bridge starts', () => {
        const run = fs.readFileSync(RUN_SCRIPT, 'utf8');
        expect(run).toMatch(/cgateweb-migrate-project/);
    });
});

describeBash('cgateweb-migrate-project (issue #174)', () => {
    test('does nothing in remote mode', () => {
        const result = runMigrate({
            config: { cgate_mode: 'remote', cgate_project: 'HOME' },
            responses: ['320 project=HOME state=stopped']
        });
        try {
            expect(result.status).toBe(0);
            expect(commands(result)).toEqual([]);
            expect(result.output.trim()).toBe('');
        } finally {
            cleanup(result);
        }
    });

    test('does nothing when the project is already started', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            responses: ['320 project=HOME state=started\n200 OK.']
        });
        try {
            expect(result.status).toBe(0);
            expect(commands(result)).toEqual(['project list']);
        } finally {
            cleanup(result);
        }
    });

    test('does not load a project that is still coming up', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            responses: [
                '320 project=HOME state=loading',
                '320 project=HOME state=loaded'
            ]
        });
        try {
            expect(commands(result)).toEqual(['project list', 'project list']);
            expect(result.output).not.toMatch(/Migrating/);
        } finally {
            cleanup(result);
        }
    });

    test('migrates a stopped project whose database schema is too old, and keeps a copy', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            withDb: true,
            responses: [
                '320 project=HOME state=stopped',
                SCHEMA_ERROR,
                '200 OK.',
                '200 OK.',
                '200 OK.',
                '200 OK.'
            ]
        });
        try {
            expect(result.status).toBe(0);
            expect(commands(result)).toEqual([
                'project list',
                'project load HOME',
                'transform migrate_sql HOME',
                'project load HOME',
                'project use HOME',
                'project start HOME'
            ]);
            const projectDir = path.join(result.cgateDir, 'Projects', 'HOME');
            expect(fs.readFileSync(path.join(projectDir, 'HOME.db.before-schema-migrate'), 'utf8')).toBe('original-database');
            expect(result.output).toMatch(/Migrating it/);
            expect(result.output).toMatch(/migrated and started/);
        } finally {
            cleanup(result);
        }
    });

    test('does not migrate a load failure that is not the schema mismatch', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            withDb: true,
            responses: [
                '320 project=HOME state=stopped',
                '408 Operation failed: Project load failed: file is locked'
            ]
        });
        try {
            expect(commands(result)).toEqual(['project list', 'project load HOME']);
            expect(fs.existsSync(path.join(result.cgateDir, 'Projects', 'HOME', 'HOME.db.before-schema-migrate'))).toBe(false);
            expect(result.output).not.toMatch(/Migrating/);
        } finally {
            cleanup(result);
        }
    });

    test('does not replace a copy saved by an earlier attempt', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            withDb: true,
            backupContents: 'first-copy',
            responses: [
                '320 project=HOME state=stopped',
                SCHEMA_ERROR,
                '408 migration failed'
            ]
        });
        try {
            expect(commands(result)).toEqual([
                'project list',
                'project load HOME',
                'transform migrate_sql HOME'
            ]);
            expect(fs.readFileSync(path.join(result.cgateDir, 'Projects', 'HOME', 'HOME.db.before-schema-migrate'), 'utf8')).toBe('first-copy');
            expect(result.output).toMatch(/failed/);
        } finally {
            cleanup(result);
        }
    });

    test('skips the migration when the project database file is missing', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            responses: [
                '320 project=HOME state=stopped',
                SCHEMA_ERROR
            ]
        });
        try {
            expect(commands(result)).toEqual(['project list', 'project load HOME']);
            expect(result.output).toMatch(/not there/);
        } finally {
            cleanup(result);
        }
    });

    test('refuses a project name that is not safe to send', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME;quit' }
        });
        try {
            expect(result.status).toBe(0);
            expect(commands(result)).toEqual([]);
            expect(result.output).toMatch(/not a usable project name/);
        } finally {
            cleanup(result);
        }
    });

    test('warns and continues when C-Gate does not answer', () => {
        const result = runMigrate({
            config: { cgate_mode: 'managed', cgate_project: 'HOME' },
            responses: ['-', '-']
        });
        try {
            expect(result.status).toBe(0);
            expect(commands(result)).toEqual(['project list', 'project list']);
            expect(result.output).toMatch(/Could not query/);
        } finally {
            cleanup(result);
        }
    });
});
