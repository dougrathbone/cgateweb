const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'tools', 'validate-settings.js');
const REAL_SETTINGS = path.join(__dirname, '..', 'settings.js');
const EXAMPLE = path.join(__dirname, '..', 'settings.js.example');

// The script reads settings.js from the repo root, which is a real developer's
// file. Swap it for the duration of each case and always put it back, so a
// failing assertion cannot destroy someone's working config.
function withSettings(contents, run) {
    const had = fs.existsSync(REAL_SETTINGS);
    const backup = had ? fs.readFileSync(REAL_SETTINGS) : null;
    try {
        if (contents === null) {
            if (had) fs.unlinkSync(REAL_SETTINGS);
        } else {
            fs.writeFileSync(REAL_SETTINGS, contents);
        }
        return run();
    } finally {
        if (backup !== null) fs.writeFileSync(REAL_SETTINGS, backup);
        else if (fs.existsSync(REAL_SETTINGS)) fs.unlinkSync(REAL_SETTINGS);
    }
}

// Exit status is the whole contract: this is a pre-flight command a user or a
// CI step runs, so "did it fail" matters more than what it printed.
function runScript() {
    try {
        const stdout = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: 'pipe' });
        return { status: 0, output: stdout };
    } catch (error) {
        return { status: error.status, output: `${error.stdout || ''}${error.stderr || ''}` };
    }
}

describe('validate-settings', () => {
    // The bug this script replaced: the old npm script only did
    // require('./settings.js'), so a config still carrying the example's
    // placeholder IP parsed fine and was reported as "valid!" - to precisely
    // the first-time user who most needed to be told otherwise.
    it('rejects the unedited example, which parses but cannot connect', () => {
        const example = fs.readFileSync(EXAMPLE, 'utf8');
        const result = withSettings(example, runScript);
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/cbusip/);
    });

    it('accepts a settings file that would actually start the bridge', () => {
        const good = [
            "exports.cbusip = '192.168.1.5';",
            "exports.cbusname = 'HOME';",
            "exports.mqtt = 'localhost:1883';",
            ''
        ].join('\n');
        const result = withSettings(good, runScript);
        expect(result.status).toBe(0);
        expect(result.output).toMatch(/valid/i);
    });

    it('tells you how to create the file when there is none, rather than throwing', () => {
        const result = withSettings(null, runScript);
        expect(result.status).toBe(1);
        expect(result.output).toMatch(/cp settings\.js\.example settings\.js/);
    });

    it('reports a settings file that is not valid JavaScript', () => {
        const result = withSettings('exports.cbusip = ;', runScript);
        expect(result.status).toBe(1);
    });

    // A setting the user omitted is not missing - it is whatever
    // defaultSettings says. Validating the raw file alone would report failures
    // the running bridge never sees.
    it('validates the file merged over the defaults, not the file alone', () => {
        // No cbuseventport, no ports, no log level: all supplied by defaults.
        const minimal = "exports.cbusip = '10.0.0.1';\nexports.mqtt = 'localhost:1883';\n";
        expect(withSettings(minimal, runScript).status).toBe(0);
    });
});
