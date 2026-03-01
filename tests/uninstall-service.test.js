const mockFs = {
    existsSync: jest.fn(),
    unlinkSync: jest.fn()
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

describe('uninstall-service.js', () => {
    let uninstallModule;
    let exitSpy;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit:${code}`);
        });

        mockFs.existsSync.mockReturnValue(true);
        mockRunCommand.mockReturnValue(true);
        mockExecSync.mockImplementation((cmd) => {
            if (cmd.includes('is-active')) return 'active';
            if (cmd.includes('is-enabled')) return 'enabled';
            throw new Error('unknown command');
        });

        uninstallModule = require('../uninstall-service');
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('exports uninstallService function', () => {
        expect(typeof uninstallModule.uninstallService).toBe('function');
    });

    it('returns early when service file is missing', () => {
        mockFs.existsSync.mockReturnValue(false);
        uninstallModule.uninstallService();
        expect(mockRunCommand).not.toHaveBeenCalled();
        expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });

    it('stops, disables, removes service and reloads systemd', () => {
        uninstallModule.uninstallService();

        expect(mockCheckRoot).toHaveBeenCalledWith('uninstall-service.js');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl stop cgateweb.service');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl disable cgateweb.service');
        expect(mockFs.unlinkSync).toHaveBeenCalledWith('/etc/systemd/system/cgateweb.service');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl daemon-reload');
        expect(mockRunCommand).toHaveBeenCalledWith('systemctl reset-failed cgateweb.service');
    });

    it('continues when service is already inactive/disabled', () => {
        mockExecSync.mockImplementation((cmd) => {
            if (cmd.includes('is-active')) return 'inactive';
            if (cmd.includes('is-enabled')) return 'disabled';
            throw new Error('unknown command');
        });

        uninstallModule.uninstallService();
        expect(mockRunCommand).not.toHaveBeenCalledWith('systemctl stop cgateweb.service');
        expect(mockRunCommand).not.toHaveBeenCalledWith('systemctl disable cgateweb.service');
        expect(mockFs.unlinkSync).toHaveBeenCalled();
    });
});
