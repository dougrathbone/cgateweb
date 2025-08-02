const { execSync } = require('child_process');

/**
 * Shared system utilities for service management scripts
 */

/**
 * Execute a shell command synchronously with logging
 * @param {string} command - The command to execute
 * @returns {boolean} - True if command succeeded, false otherwise
 */
function runCommand(command) {
    try {
        console.log(`Executing: ${command}`);
        execSync(command, { stdio: 'inherit' });
        console.log(`Successfully executed: ${command}`);
        return true;
    } catch (error) {
        console.error(`Failed to execute command: ${command}`);
        console.error(error.stderr ? error.stderr.toString() : error.message);
        return false;
    }
}

/**
 * Check if the current process is running with root privileges
 * Exits the process with error if not running as root
 * @param {string} scriptName - Name of the script for error message
 */
function checkRoot(scriptName = 'this script') {
    if (process.getuid && process.getuid() !== 0) {
        console.error(`This script requires root privileges to manage systemd services and system files.`);
        console.error(`Please run using sudo: sudo node ${scriptName}`);
        process.exit(1);
    }
}

module.exports = {
    runCommand,
    checkRoot
};