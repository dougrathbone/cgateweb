#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVICE_NAME = 'cgateweb.service';
const TARGET_SYSTEMD_DIR = '/etc/systemd/system';
const TARGET_SERVICE_FILE = path.join(TARGET_SYSTEMD_DIR, SERVICE_NAME);

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

function checkRoot() {
    if (process.getuid && process.getuid() !== 0) {
        console.error('This script requires root privileges to manage systemd services and remove files from /etc.');
        console.error('Please run using sudo: sudo node uninstall-service.js');
        process.exit(1);
    }
}

function uninstallService() {
    console.log('--- cgateweb Systemd Service Uninstaller ---');

    checkRoot();

    // 1. Check if service file exists
    if (!fs.existsSync(TARGET_SERVICE_FILE)) {
        console.log(`Service file not found: ${TARGET_SERVICE_FILE}`);
        console.log('Service may not be installed or already removed.');
        return;
    }

    // 2. Stop the service if it's running
    try {
        const status = execSync(`systemctl is-active ${SERVICE_NAME}`, { encoding: 'utf8' }).trim();
        if (status === 'active') {
            console.log(`Stopping ${SERVICE_NAME} service...`);
            if (!runCommand(`systemctl stop ${SERVICE_NAME}`)) {
                console.error(`Failed to stop ${SERVICE_NAME}. Continuing with uninstallation...`);
            }
        } else {
            console.log(`Service ${SERVICE_NAME} is not active.`);
        }
    } catch (error) {
        console.log(`Service ${SERVICE_NAME} status check failed (may not exist).`);
    }

    // 3. Disable the service
    try {
        const enabled = execSync(`systemctl is-enabled ${SERVICE_NAME}`, { encoding: 'utf8' }).trim();
        if (enabled === 'enabled') {
            console.log(`Disabling ${SERVICE_NAME} service...`);
            if (!runCommand(`systemctl disable ${SERVICE_NAME}`)) {
                console.error(`Failed to disable ${SERVICE_NAME}. Continuing with uninstallation...`);
            }
        } else {
            console.log(`Service ${SERVICE_NAME} is not enabled.`);
        }
    } catch (error) {
        console.log(`Service ${SERVICE_NAME} enable status check failed (may not exist).`);
    }

    // 4. Remove the service file
    try {
        console.log(`Removing service file: ${TARGET_SERVICE_FILE}`);
        fs.unlinkSync(TARGET_SERVICE_FILE);
        console.log('Service file removed successfully.');
    } catch (error) {
        console.error(`Failed to remove service file: ${error.message}`);
        process.exit(1);
    }

    // 5. Reload systemd daemon
    if (!runCommand('systemctl daemon-reload')) {
        console.error('Failed to reload systemd daemon. Service may still appear in systemctl.');
    }

    // 6. Reset failed state (if any)
    runCommand(`systemctl reset-failed ${SERVICE_NAME}`);

    console.log('---');
    console.log(`cgateweb service uninstallation completed.`);
    console.log(`The service ${SERVICE_NAME} has been stopped, disabled, and removed.`);
    console.log('Application files in the installation directory were not removed.');
    console.log('---');
}

// Run the uninstallation
uninstallService();