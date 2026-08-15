const path = require('path');

const mockFs = {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    copyFileSync: jest.fn()
};
const mockExecSync = jest.fn();
const mockRunCommand = jest.fn();
const mockCheckRoot = jest.fn();

jest.mock('fs', () => mockFs);
jest.mock('child_process', () => ({ execSync: mockExecSync }));
jest.mock('../src/systemUtils', () => ({
    runCommand: (...args) => mockRunCommand(...args),
    checkRoot: (...args) => mockCheckRoot(...args)
}));

// isUnderHome decides whether the unit ships ProtectHome=yes. It is tested
// directly rather than through installService because, inline, its coverage
// depended on the checkout path: CI runs under /home/runner so the branch
// executed there, and on a developer's machine it did not - the same commit
// scored 77.14% on CI and 74.28% locally, against a 75% threshold.
describe('isUnderHome', () => {
    const { isUnderHome } = require('../install-service');

    it.each([
        ['/home/pi/cgateweb', true],
        ['/home/doug/code/cgateweb', true],
        ['/home', true],
        ['/opt/cgateweb', false],
        ['/usr/local/cgateweb', false],
        ['/srv/cgateweb', false],
        // Not a home directory despite the prefix - the check is path-segment
        // aware, so a sibling directory named /homelab must not match.
        ['/homelab/cgateweb', false],
        ['/var/home/cgateweb', false]
    ])('%s -> %s', (installPath, expected) => {
        expect(isUnderHome(installPath)).toBe(expected);
    });
});

describe('resolveProtectHome', () => {
    const { resolveProtectHome } = require('../install-service');

    it('keeps ProtectHome on and says nothing for a system location', () => {
        expect(resolveProtectHome('/opt/cgateweb')).toEqual({ value: 'yes', warnings: [] });
    });

    it('disables it under /home and explains why, naming the path', () => {
        const result = resolveProtectHome('/home/pi/cgateweb');
        expect(result.value).toBe('no');
        expect(result.warnings).toHaveLength(3);
        expect(result.warnings[0]).toContain('/home/pi/cgateweb');
        // The remedy has to be in the warning: a user who only sees "ProtectHome
        // disabled" has no idea what to do about it.
        expect(result.warnings.join(' ')).toContain('/opt/cgateweb');
    });
});

describe('install-service.js', () => {
    let exitSpy;
    let installModule;

    beforeEach(() => {
        jest.resetModules();
        // resetAllMocks, not clearAllMocks: clearAllMocks only wipes recorded
        // calls, it leaves mockImplementation/mockReturnValue in place. The
        // "writing service file fails" test installs a throwing writeFileSync
        // that nothing below re-stubs, so under clearAllMocks it survives into
        // whichever test runs next and makes the happy-path installs exit(1).
        jest.resetAllMocks();

        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit:${code}`);
        });

        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue('[Service]\nWorkingDirectory=%I\n');
        mockRunCommand.mockReturnValue(true);
        mockExecSync.mockImplementation(() => {
            throw new Error('inactive');
        });

        installModule = require('../install-service');
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('exports callable install helpers', () => {
        expect(typeof installModule.installService).toBe('function');
        expect(typeof installModule.checkDependencies).toBe('function');
        expect(typeof installModule.ensureServiceUser).toBe('function');
    });

    it('runs install flow and writes templated service file', () => {
        installModule.installService();

        expect(mockCheckRoot).toHaveBeenCalledWith('install-service.js');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl daemon-reload');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl enable cgateweb.service');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl start cgateweb.service');
        expect(mockFs.writeFileSync).toHaveBeenCalledWith(
            '/etc/systemd/system/cgateweb.service',
            expect.stringContaining(path.resolve(__dirname, '..')),
            { encoding: 'utf8', mode: 0o644 }
        );
    });

    it('stops existing active service before install', () => {
        mockExecSync.mockReturnValue('active');
        installModule.installService();
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl stop cgateweb.service');
    });

    it('exits when template file is missing', () => {
        mockFs.existsSync.mockImplementation((p) => !String(p).endsWith('cgateweb.service.template'));
        expect(() => installModule.installService()).toThrow('process.exit:1');
    });

    it('exits when writing service file fails', () => {
        mockFs.writeFileSync.mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(() => installModule.installService()).toThrow('process.exit:1');
    });

    it('ensures service user is created when missing', () => {
        mockRunCommand.mockImplementation((cmd) => {
            if (cmd === 'id cgateweb') return false;
            return true;
        });
        installModule.ensureServiceUser();
        expect(mockRunCommand).toHaveBeenCalledWith('useradd --system --user-group --no-create-home --shell /usr/sbin/nologin cgateweb');
    });
});