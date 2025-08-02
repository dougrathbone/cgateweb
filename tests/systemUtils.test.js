const { runCommand, checkRoot } = require('../src/systemUtils');

// Mock child_process
jest.mock('child_process');
const { execSync } = require('child_process');

describe('systemUtils', () => {
    let consoleLogSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('runCommand', () => {
        it('should execute command successfully', () => {
            execSync.mockReturnValue('success output');
            
            const result = runCommand('test command');
            
            expect(result).toBe(true);
            expect(execSync).toHaveBeenCalledWith('test command', { stdio: 'inherit' });
            expect(consoleLogSpy).toHaveBeenCalledWith('Executing: test command');
            expect(consoleLogSpy).toHaveBeenCalledWith('Successfully executed: test command');
        });

        it('should handle command execution failure', () => {
            const error = new Error('Command failed');
            error.stderr = Buffer.from('Error output');
            execSync.mockImplementation(() => {
                throw error;
            });
            
            const result = runCommand('failing command');
            
            expect(result).toBe(false);
            expect(consoleLogSpy).toHaveBeenCalledWith('Executing: failing command');
            expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to execute command: failing command');
            expect(consoleErrorSpy).toHaveBeenCalledWith('Error output');
        });

        it('should handle command execution failure without stderr', () => {
            const error = new Error('Command failed without stderr');
            execSync.mockImplementation(() => {
                throw error;
            });
            
            const result = runCommand('failing command');
            
            expect(result).toBe(false);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to execute command: failing command');
            expect(consoleErrorSpy).toHaveBeenCalledWith('Command failed without stderr');
        });

        it('should handle stderr as string', () => {
            const error = new Error('Command failed');
            error.stderr = 'String error output';
            execSync.mockImplementation(() => {
                throw error;
            });
            
            const result = runCommand('failing command');
            
            expect(result).toBe(false);
            expect(consoleErrorSpy).toHaveBeenCalledWith('String error output');
        });
    });

    describe('checkRoot', () => {
        let originalGetuid;
        let processExitSpy;

        beforeEach(() => {
            originalGetuid = process.getuid;
            processExitSpy = jest.spyOn(process, 'exit').mockImplementation();
        });

        afterEach(() => {
            process.getuid = originalGetuid;
            processExitSpy.mockRestore();
        });

        it('should pass when running as root (uid 0)', () => {
            process.getuid = jest.fn().mockReturnValue(0);
            
            expect(() => checkRoot()).not.toThrow();
            expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should exit when not running as root', () => {
            process.getuid = jest.fn().mockReturnValue(1000);
            
            checkRoot();
            
            expect(consoleErrorSpy).toHaveBeenCalledWith('This script requires root privileges to manage systemd services and system files.');
            expect(consoleErrorSpy).toHaveBeenCalledWith('Please run using sudo: sudo node this script');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });

        it('should use custom script name in error message', () => {
            process.getuid = jest.fn().mockReturnValue(1000);
            
            checkRoot('custom-script.js');
            
            expect(consoleErrorSpy).toHaveBeenCalledWith('Please run using sudo: sudo node custom-script.js');
        });

        it('should handle systems without getuid function', () => {
            process.getuid = undefined;
            
            expect(() => checkRoot()).not.toThrow();
            expect(processExitSpy).not.toHaveBeenCalled();
        });
    });
});