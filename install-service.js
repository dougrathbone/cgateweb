#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVICE_NAME = 'cgateweb.service';
const SOURCE_SERVICE_FILE = path.join(__dirname, SERVICE_NAME);
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
        console.error('This script requires root privileges to copy files to /etc and manage systemd.');
        console.error('Please run using sudo: sudo node install-service.js');
        process.exit(1);
    }
}

function installService() {
    console.log('--- cgateweb Systemd Service Installer ---');

    checkRoot();

    // 1. Check if source service file exists
    if (!fs.existsSync(SOURCE_SERVICE_FILE)) {
        console.error(`Source service file not found: ${SOURCE_SERVICE_FILE}`);
        process.exit(1);
    }
    console.log(`Found source service file: ${SOURCE_SERVICE_FILE}`);

    // 2. Check if target directory exists (usually does, but good practice)
    if (!fs.existsSync(TARGET_SYSTEMD_DIR)) {
        console.error(`Target systemd directory not found: ${TARGET_SYSTEMD_DIR}`);
        console.error('Is systemd installed and running correctly?');
        process.exit(1);
    }

    // 3. Copy service file
    try {
        console.log(`Copying ${SOURCE_SERVICE_FILE} to ${TARGET_SERVICE_FILE}...`);
        fs.copyFileSync(SOURCE_SERVICE_FILE, TARGET_SERVICE_FILE);
        fs.chmodSync(TARGET_SERVICE_FILE, '644'); // Set standard permissions
        console.log('Service file copied successfully.');
    } catch (error) {
        console.error(`Failed to copy service file: ${error.message}`);
        process.exit(1);
    }

    // 4. Reload systemd daemon
    if (!runCommand('systemctl daemon-reload')) {
        console.error('Failed to reload systemd daemon. Service might not be recognized yet.');
        // Continue installation attempt but warn user
    }

    // 5. Enable the service (to start on boot)
    if (!runCommand(`systemctl enable ${SERVICE_NAME}`)) {
        console.error(`Failed to enable ${SERVICE_NAME}. It may not start automatically on boot.`);
        // Continue installation attempt
    }

    // 6. Start the service
    if (!runCommand(`systemctl start ${SERVICE_NAME}`)) {
        console.error(`Failed to start ${SERVICE_NAME}. Check service status with: systemctl status ${SERVICE_NAME}`);
        process.exit(1); // Exit with error if start fails
    }

    console.log('---');
    console.log(`cgateweb service installation completed.`);
    console.log(`Use 'systemctl status ${SERVICE_NAME}' to check its status.`);
    console.log(`Use 'journalctl -u ${SERVICE_NAME} -f' to follow its logs.`);
    console.log('---');
}

// Run the installation
installService(); 