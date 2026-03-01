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

describe('install-service.js', () => {
    let exitSpy;
    let installModule;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

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
        expect(mockRunCommand).toHaveBeenCalledWith('useradd --system --no-create-home --shell /usr/sbin/nologin cgateweb');
    });
});