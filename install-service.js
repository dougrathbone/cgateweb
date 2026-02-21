#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runCommand, checkRoot } = require('./src/systemUtils');

const SERVICE_NAME = 'cgateweb.service';
const SOURCE_SERVICE_FILE_TEMPLATE = path.join(__dirname, 'cgateweb.service.template');
const TARGET_SYSTEMD_DIR = '/etc/systemd/system';
const TARGET_SERVICE_FILE = path.join(TARGET_SYSTEMD_DIR, SERVICE_NAME);
const BASE_INSTALL_PATH = __dirname;


function checkDependencies() {
    console.log('Checking dependencies...');
    
    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (majorVersion < 18) {
        console.error(`Node.js version ${nodeVersion} is too old. Minimum required: v18.0.0`);
        process.exit(1);
    }
    console.log(`Node.js version: ${nodeVersion} ✓`);
    
    // Check if package.json exists
    const packageJsonPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        console.error('package.json not found. Please run from the cgateweb directory.');
        process.exit(1);
    }
    
    // Check if settings.js exists
    const settingsPath = path.join(__dirname, 'settings.js');
    if (!fs.existsSync(settingsPath)) {
        console.warn('WARNING: settings.js not found. Application will use default settings.');
        console.warn('Please create and configure settings.js before starting the service.');
    } else {
        console.log('Configuration file: settings.js ✓');
    }
    
    // Check if node_modules exists
    const nodeModulesPath = path.join(__dirname, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        console.error('node_modules directory not found.');
        console.error('Please run "npm install" first to install dependencies.');
        process.exit(1);
    }
    console.log('Dependencies installed ✓');
}

function ensureServiceUser() {
    const username = 'cgateweb';
    try {
        runCommand(`id ${username}`);
        console.log(`Service user '${username}' already exists ✓`);
    } catch (_e) {
        console.log(`Creating service user '${username}'...`);
        if (!runCommand(`useradd --system --no-create-home --shell /usr/sbin/nologin ${username}`)) {
            console.error(`Failed to create service user '${username}'.`);
            process.exit(1);
        }
        console.log(`Service user '${username}' created ✓`);
    }
}

function installService() {
    console.log('--- cgateweb Systemd Service Installer ---');

    checkRoot('install-service.js');
    checkDependencies();
    ensureServiceUser();

    // 1. Check if source service file template exists
    if (!fs.existsSync(SOURCE_SERVICE_FILE_TEMPLATE)) {
        console.error(`Source service file template not found: ${SOURCE_SERVICE_FILE_TEMPLATE}`);
        console.error('Please ensure cgateweb.service.template exists in the same directory.');
        process.exit(1);
    }
    console.log(`Found source service file template: ${SOURCE_SERVICE_FILE_TEMPLATE}`);

    // 2. Check if target directory exists
    if (!fs.existsSync(TARGET_SYSTEMD_DIR)) {
        console.error(`Target systemd directory not found: ${TARGET_SYSTEMD_DIR}`);
        console.error('Is systemd installed and running correctly?');
        process.exit(1);
    }

    // 2.1. Check if service is already running and stop it first
    try {
        const status = execSync(`systemctl is-active ${SERVICE_NAME}`, { encoding: 'utf8' }).trim();
        if (status === 'active') {
            console.log(`Stopping existing ${SERVICE_NAME} service...`);
            if (!runCommand(`systemctl stop ${SERVICE_NAME}`)) {
                console.warn('Failed to stop existing service, continuing with installation...');
            }
        }
    } catch (error) {
        // Service doesn't exist or is inactive, which is fine
        console.log('No existing service to stop.');
    }

    // 3. Read template, replace placeholder, and write target service file
    try {
        console.log(`Reading service template: ${SOURCE_SERVICE_FILE_TEMPLATE}`);
        let serviceContent = fs.readFileSync(SOURCE_SERVICE_FILE_TEMPLATE, 'utf8');
        
        console.log(`Replacing %I placeholder with path: ${BASE_INSTALL_PATH}`);
        // Use a regular expression with the 'g' flag to replace all occurrences
        serviceContent = serviceContent.replace(/%I/g, BASE_INSTALL_PATH);
        
        // Backup existing service file if it exists
        if (fs.existsSync(TARGET_SERVICE_FILE)) {
            const backupFile = `${TARGET_SERVICE_FILE}.backup.${Date.now()}`;
            console.log(`Backing up existing service file to: ${backupFile}`);
            fs.copyFileSync(TARGET_SERVICE_FILE, backupFile);
        }
        
        console.log(`Writing configured service file to ${TARGET_SERVICE_FILE}...`);
        fs.writeFileSync(TARGET_SERVICE_FILE, serviceContent, { encoding: 'utf8', mode: 0o644 });
        console.log('Service file written successfully.');

    } catch (error) {
        console.error(`Failed to process service file: ${error.message}`);
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
    console.log(`To stop the service: systemctl stop ${SERVICE_NAME}`);
    console.log(`To restart the service: systemctl restart ${SERVICE_NAME}`);
    console.log(`To uninstall the service: systemctl stop ${SERVICE_NAME} && systemctl disable ${SERVICE_NAME} && rm ${TARGET_SERVICE_FILE}`);
    console.log('---');
}

// Run the installation
installService(); 