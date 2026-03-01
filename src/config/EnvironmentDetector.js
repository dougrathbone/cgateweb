const fs = require('fs');
const path = require('path');
const { Logger } = require('../logger');

/**
 * Detects the installation environment (standalone vs Home Assistant addon)
 * and provides environment-specific information
 */
class EnvironmentDetector {
    constructor() {
        this.logger = new Logger({ component: 'EnvironmentDetector' });
        this._detectedEnvironment = null;
        this._environmentInfo = null;
    }

    /**
     * Detect the current installation environment
     * @returns {Object} Environment information
     */
    detect() {
        if (this._detectedEnvironment) {
            return this._environmentInfo;
        }

        this.logger.debug('Detecting installation environment...');

        // Check for Home Assistant addon indicators
        const haIndicators = this._checkHomeAssistantIndicators();
        
        if (haIndicators.isAddon) {
            this._detectedEnvironment = 'addon';
            this._environmentInfo = {
                type: 'addon',
                isStandalone: false,
                isAddon: true,
                optionsPath: haIndicators.optionsPath,
                dataPath: haIndicators.dataPath,
                configPath: haIndicators.configPath,
                supervisorToken: haIndicators.supervisorToken,
                indicators: haIndicators
            };
            this.logger.info('Detected Home Assistant addon environment');
        } else {
            this._detectedEnvironment = 'standalone';
            this._environmentInfo = {
                type: 'standalone',
                isStandalone: true,
                isAddon: false,
                settingsPath: this._findSettingsFile(),
                workingDirectory: process.cwd(),
                indicators: {
                    hasSettingsFile: this._hasSettingsFile(),
                    runningInDocker: this._isRunningInDocker()
                }
            };
            this.logger.info('Detected standalone installation environment');
        }

        return this._environmentInfo;
    }

    /**
     * Check for Home Assistant addon environment indicators
     * @private
     */
    _checkHomeAssistantIndicators() {
        const indicators = {
            isAddon: false,
            optionsPath: '/data/options.json',
            dataPath: '/data',
            configPath: '/config',
            supervisorToken: null,
            hasOptionsFile: false,
            hasDataDirectory: false,
            hasConfigDirectory: false,
            hasSupervisorToken: false,
            hasIngress: false
        };

        // Check for /data/options.json (primary indicator)
        indicators.hasOptionsFile = this._fileExists(indicators.optionsPath);
        
        // Check for /data directory
        indicators.hasDataDirectory = this._directoryExists(indicators.dataPath);
        
        // Check for /config directory (Home Assistant config mount)
        indicators.hasConfigDirectory = this._directoryExists(indicators.configPath);
        
        // Check for Supervisor token environment variable
        indicators.supervisorToken = process.env.SUPERVISOR_TOKEN;
        indicators.hasSupervisorToken = !!indicators.supervisorToken;
        
        // Check for ingress session environment variable
        indicators.hasIngress = !!process.env.INGRESS_SESSION;

        // Determine if this is an addon environment
        // Primary: options file exists and data directory exists
        // Secondary: has supervisor token or ingress session
        indicators.isAddon = (
            indicators.hasOptionsFile && indicators.hasDataDirectory
        ) || (
            indicators.hasSupervisorToken || indicators.hasIngress
        );

        this.logger.debug('Home Assistant indicators check:', indicators);
        
        return indicators;
    }

    /**
     * Find the settings.js file for standalone installations
     * @private
     */
    _findSettingsFile() {
        const possiblePaths = [
            path.join(process.cwd(), 'settings.js'),
            path.join(__dirname, '../../settings.js'),
            path.join(process.cwd(), 'config', 'settings.js'),
            './settings.js'
        ];

        for (const settingsPath of possiblePaths) {
            if (this._fileExists(settingsPath)) {
                this.logger.debug(`Found settings file at: ${settingsPath}`);
                return path.resolve(settingsPath);
            }
        }

        this.logger.warn('No settings.js file found in common locations');
        return path.join(process.cwd(), 'settings.js'); // Default fallback
    }

    /**
     * Check if settings.js file exists
     * @private
     */
    _hasSettingsFile() {
        const settingsPath = this._findSettingsFile();
        return this._fileExists(settingsPath);
    }

    /**
     * Detect if running inside Docker container
     * @private
     */
    _isRunningInDocker() {
        try {
            // Check for Docker-specific files/environment
            return (
                this._fileExists('/.dockerenv') ||
                process.env.DOCKER_CONTAINER === 'true' ||
                this._fileExists('/proc/1/cgroup') && 
                fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker')
            );
        } catch (error) {
            this.logger.debug('Error checking Docker environment:', error.message);
            return false;
        }
    }

    /**
     * Check if a file exists
     * @private
     */
    _fileExists(filePath) {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Check if a directory exists
     * @private
     */
    _directoryExists(dirPath) {
        try {
            return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Get current environment type
     */
    getEnvironmentType() {
        if (!this._detectedEnvironment) {
            this.detect();
        }
        return this._detectedEnvironment;
    }

    /**
     * Check if running in Home Assistant addon
     */
    isAddon() {
        return this.getEnvironmentType() === 'addon';
    }

    /**
     * Check if running in standalone mode
     */
    isStandalone() {
        return this.getEnvironmentType() === 'standalone';
    }

    /**
     * Get environment information
     */
    getEnvironmentInfo() {
        if (!this._environmentInfo) {
            this.detect();
        }
        return this._environmentInfo;
    }

    /**
     * Reset detection (for testing)
     */
    reset() {
        this._detectedEnvironment = null;
        this._environmentInfo = null;
    }
}

module.exports = EnvironmentDetector;
