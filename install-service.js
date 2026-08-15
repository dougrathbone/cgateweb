#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runCommand, checkRoot } = require('./src/systemUtils');

const SERVICE_NAME = 'cgateweb.service';
const SOURCE_SERVICE_FILE_TEMPLATE = path.join(__dirname, 'cgateweb.service.template');
const TARGET_SYSTEMD_DIR = '/etc/systemd/system';
// systemd paths are always POSIX; use path.posix so the constant is correct
// even when this file is required on a non-POSIX dev host (e.g. Windows tests).
const TARGET_SERVICE_FILE = path.posix.join(TARGET_SYSTEMD_DIR, SERVICE_NAME);
const BASE_INSTALL_PATH = __dirname;


function checkDependencies() {
    console.log('Checking dependencies...');
    
    // Check Node.js version. Keep the minimum aligned with package.json engines
    // (^20.19.0 || ^22.13.0 || >=24).
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (majorVersion < 20) {
        console.error(`Node.js version ${nodeVersion} is too old. Minimum required: v20.19.0`);
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
    if (runCommand(`id ${username}`)) {
        console.log(`Service user '${username}' already exists ✓`);
    } else {
        console.log(`Creating service user '${username}'...`);
        // --user-group creates the matching group the unit's Group= needs.
        // Debian's useradd happens to do this by default; not every distro
        // does, and there the unit fails on group resolution.
        if (!runCommand(`useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ${username}`)) {
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
    } catch {
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

        // The interpreter running this installer is the one we just version
        // checked, so it is the one the unit should run. Hardcoding
        // /usr/bin/node meant a supported Node installed via nvm/fnm/asdf
        // passed the check and then failed 203/EXEC at start.
        console.log(`Using node binary: ${process.execPath}`);
        serviceContent = serviceContent.replace(/%NODE%/g, process.execPath);

        // ProtectHome=yes hides /home from the unit, so an install under /home
        // cannot even chdir into its own WorkingDirectory (200/CHDIR). Relax it
        // rather than ship a unit that cannot start, and say so - /opt is the
        // better home for a system service.
        const installedUnderHome = BASE_INSTALL_PATH === '/home' || BASE_INSTALL_PATH.startsWith('/home/');
        if (installedUnderHome) {
            console.warn(`WARNING: installing from ${BASE_INSTALL_PATH}, which is under /home.`);
            console.warn('         ProtectHome must be disabled for the service to start from there.');
            console.warn('         Consider moving the checkout to /opt/cgateweb and re-running this installer.');
        }
        serviceContent = serviceContent.replace(/%PROTECT_HOME%/g, installedUnderHome ? 'no' : 'yes');
        
        // Backup existing service file if it exists
        if (fs.existsSync(TARGET_SERVICE_FILE)) {
            const backupFile = `${TARGET_SERVICE_FILE}.backup.${Date.now()}`;
            console.log(`Backing up existing service file to: ${backupFile}`);
            fs.copyFileSync(TARGET_SERVICE_FILE, backupFile);
        }
        
        console.log(`Writing configured service file to ${TARGET_SERVICE_FILE}...`);
        fs.writeFileSync(TARGET_SERVICE_FILE, serviceContent, { encoding: 'utf8', mode: 0o644 });
        console.log('Service file written successfully.');

        // The unit runs as 'cgateweb', not as whoever cloned the repo. Nothing
        // chowns the checkout - doing so would take a developer's own working
        // copy away from them - so check the service user can actually read the
        // entry point and say exactly how to fix it if not. ReadWritePaths only
        // lifts systemd's own restrictions; POSIX permissions still apply.
        const entryPoint = path.join(BASE_INSTALL_PATH, 'index.js');
        if (!runCommand(`sudo -u cgateweb test -r ${entryPoint}`)) {
            console.warn(`WARNING: service user 'cgateweb' cannot read ${entryPoint}.`);
            console.warn('         The service will fail to start. Grant access with either:');
            console.warn(`           sudo chgrp -R cgateweb ${BASE_INSTALL_PATH} && sudo chmod -R g+rX ${BASE_INSTALL_PATH}`);
            console.warn(`           sudo chown -R cgateweb:cgateweb ${BASE_INSTALL_PATH}   (gives up your own write access)`);
        }

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
if (require.main === module || (require.main && require.main.filename === __filename)) {
    installService();
}

module.exports = {
    installService,
    checkDependencies,
    ensureServiceUser
};