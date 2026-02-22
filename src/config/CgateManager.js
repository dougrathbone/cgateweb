const { Logger } = require('../logger');
const fs = require('fs');
const path = require('path');
const net = require('net');

/**
 * Manages C-Gate lifecycle awareness for the addon.
 * In managed mode, monitors C-Gate health. In remote mode,
 * simply verifies connectivity.
 */
class CgateManager {
    constructor(config = {}) {
        this.logger = new Logger({ component: 'CgateManager' });
        this.mode = config.cgate_mode || 'remote';
        this.host = config.cbusip || '127.0.0.1';
        this.commandPort = config.cbuscommandport || 20023;
        this.eventPort = config.cbuseventport || 20025;
        this.installSource = config.cgate_install_source || 'download';
        this.downloadUrl = config.cgate_download_url || '';
        this._healthCheckInterval = null;
    }

    /**
     * Check if C-Gate is reachable on both command and event ports
     * @param {number} timeoutMs - connection timeout in ms
     * @returns {Promise<Object>} health status
     */
    async checkHealth(timeoutMs = 3000) {
        const results = {
            mode: this.mode,
            host: this.host,
            commandPort: { port: this.commandPort, reachable: false },
            eventPort: { port: this.eventPort, reachable: false },
            healthy: false,
            timestamp: new Date().toISOString()
        };

        const [commandOk, eventOk] = await Promise.all([
            this._checkPort(this.host, this.commandPort, timeoutMs),
            this._checkPort(this.host, this.eventPort, timeoutMs)
        ]);

        results.commandPort.reachable = commandOk;
        results.eventPort.reachable = eventOk;
        results.healthy = commandOk && eventOk;

        return results;
    }

    /**
     * Check if a TCP port is reachable
     * @private
     */
    _checkPort(host, port, timeoutMs) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;

            const done = (result) => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve(result);
                }
            };

            socket.setTimeout(timeoutMs);
            socket.on('connect', () => done(true));
            socket.on('error', () => done(false));
            socket.on('timeout', () => done(false));

            socket.connect(port, host);
        });
    }

    /**
     * Check if C-Gate is installed (managed mode only)
     * @returns {Object} installation status
     */
    getInstallationStatus() {
        if (this.mode !== 'managed') {
            return { installed: null, mode: 'remote', message: 'Not applicable in remote mode' };
        }

        const cgateDir = '/data/cgate';
        const cgateJar = path.join(cgateDir, 'cgate.jar');

        const installed = fs.existsSync(cgateJar);
        const hasConfig = fs.existsSync(path.join(cgateDir, 'config', 'access.txt'));

        return {
            installed,
            hasConfig,
            mode: 'managed',
            installSource: this.installSource,
            cgateDir,
            message: installed ? 'C-Gate is installed' : 'C-Gate not yet installed'
        };
    }

    /**
     * Check if a C-Gate zip file is available for upload installation
     * @returns {Object} upload status
     */
    getUploadStatus() {
        const shareDir = '/share/cgate';
        
        if (!fs.existsSync(shareDir)) {
            return { available: false, files: [], message: 'Upload directory does not exist' };
        }

        try {
            const files = fs.readdirSync(shareDir).filter(f => f.endsWith('.zip'));
            return {
                available: files.length > 0,
                files,
                directory: shareDir,
                message: files.length > 0
                    ? `Found ${files.length} zip file(s)`
                    : 'No zip files found in /share/cgate/'
            };
        } catch (error) {
            return { available: false, files: [], message: `Error reading directory: ${error.message}` };
        }
    }

    /**
     * Get comprehensive status for health reporting
     * @returns {Promise<Object>}
     */
    async getStatus() {
        const health = await this.checkHealth();
        const status = {
            ...health,
            installation: this.getInstallationStatus()
        };

        if (this.mode === 'managed' && this.installSource === 'upload') {
            status.upload = this.getUploadStatus();
        }

        return status;
    }
}

module.exports = CgateManager;
