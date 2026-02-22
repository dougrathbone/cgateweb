const fs = require('fs');
const net = require('net');
const CgateManager = require('../../src/config/CgateManager');

jest.mock('fs');

describe('CgateManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        test('should use defaults when no config provided', () => {
            const manager = new CgateManager();
            expect(manager.mode).toBe('remote');
            expect(manager.host).toBe('127.0.0.1');
            expect(manager.commandPort).toBe(20023);
            expect(manager.eventPort).toBe(20025);
        });

        test('should use provided config values', () => {
            const manager = new CgateManager({
                cgate_mode: 'managed',
                cbusip: '192.168.1.100',
                cbuscommandport: 20123,
                cbuseventport: 20125,
                cgate_install_source: 'upload'
            });
            expect(manager.mode).toBe('managed');
            expect(manager.host).toBe('192.168.1.100');
            expect(manager.commandPort).toBe(20123);
            expect(manager.eventPort).toBe(20125);
            expect(manager.installSource).toBe('upload');
        });
    });

    describe('checkHealth', () => {
        let server;

        afterEach((done) => {
            if (server && server.listening) {
                server.close(done);
            } else {
                done();
            }
        });

        test('should report healthy when both ports are reachable', async () => {
            const port = 30000 + Math.floor(Math.random() * 10000);
            server = net.createServer();
            await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

            const manager = new CgateManager({
                cbusip: '127.0.0.1',
                cbuscommandport: port,
                cbuseventport: port
            });

            const health = await manager.checkHealth(1000);
            expect(health.commandPort.reachable).toBe(true);
            expect(health.eventPort.reachable).toBe(true);
            expect(health.healthy).toBe(true);
        });

        test('should report unhealthy when ports are not reachable', async () => {
            const manager = new CgateManager({
                cbusip: '127.0.0.1',
                cbuscommandport: 59999,
                cbuseventport: 59998
            });

            const health = await manager.checkHealth(500);
            expect(health.commandPort.reachable).toBe(false);
            expect(health.eventPort.reachable).toBe(false);
            expect(health.healthy).toBe(false);
        });

        test('should include mode and timestamp in health result', async () => {
            const manager = new CgateManager({ cgate_mode: 'managed' });
            const health = await manager.checkHealth(100);
            expect(health.mode).toBe('managed');
            expect(health.timestamp).toBeDefined();
            expect(new Date(health.timestamp).getTime()).not.toBeNaN();
        });
    });

    describe('getInstallationStatus', () => {
        test('should return not applicable in remote mode', () => {
            const manager = new CgateManager({ cgate_mode: 'remote' });
            const status = manager.getInstallationStatus();
            expect(status.installed).toBeNull();
            expect(status.mode).toBe('remote');
        });

        test('should detect installed C-Gate in managed mode', () => {
            fs.existsSync.mockImplementation((p) => {
                if (p === '/data/cgate/cgate.jar') return true;
                if (p === '/data/cgate/config/access.txt') return true;
                return false;
            });

            const manager = new CgateManager({ cgate_mode: 'managed' });
            const status = manager.getInstallationStatus();
            expect(status.installed).toBe(true);
            expect(status.hasConfig).toBe(true);
            expect(status.mode).toBe('managed');
        });

        test('should detect missing C-Gate in managed mode', () => {
            fs.existsSync.mockReturnValue(false);

            const manager = new CgateManager({ cgate_mode: 'managed' });
            const status = manager.getInstallationStatus();
            expect(status.installed).toBe(false);
            expect(status.hasConfig).toBe(false);
        });
    });

    describe('getUploadStatus', () => {
        test('should report unavailable when directory does not exist', () => {
            fs.existsSync.mockReturnValue(false);

            const manager = new CgateManager();
            const status = manager.getUploadStatus();
            expect(status.available).toBe(false);
            expect(status.files).toEqual([]);
        });

        test('should find zip files in upload directory', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readdirSync.mockReturnValue(['cgate-3.4.1.zip', 'readme.txt', 'old-cgate.zip']);

            const manager = new CgateManager();
            const status = manager.getUploadStatus();
            expect(status.available).toBe(true);
            expect(status.files).toEqual(['cgate-3.4.1.zip', 'old-cgate.zip']);
        });

        test('should report empty when no zip files found', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readdirSync.mockReturnValue(['readme.txt', 'notes.md']);

            const manager = new CgateManager();
            const status = manager.getUploadStatus();
            expect(status.available).toBe(false);
            expect(status.files).toEqual([]);
        });

        test('should handle read errors gracefully', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readdirSync.mockImplementation(() => { throw new Error('Permission denied'); });

            const manager = new CgateManager();
            const status = manager.getUploadStatus();
            expect(status.available).toBe(false);
            expect(status.message).toContain('Permission denied');
        });
    });

    describe('getStatus', () => {
        test('should return comprehensive status for remote mode', async () => {
            const manager = new CgateManager({
                cgate_mode: 'remote',
                cbusip: '127.0.0.1',
                cbuscommandport: 59997,
                cbuseventport: 59996
            });

            const status = await manager.getStatus();
            expect(status.mode).toBe('remote');
            expect(status.installation).toBeDefined();
            expect(status.installation.installed).toBeNull();
            expect(status.upload).toBeUndefined();
        });

        test('should include upload status for managed upload mode', async () => {
            fs.existsSync.mockReturnValue(false);

            const manager = new CgateManager({
                cgate_mode: 'managed',
                cgate_install_source: 'upload',
                cbuscommandport: 59995,
                cbuseventport: 59994
            });

            const status = await manager.getStatus();
            expect(status.mode).toBe('managed');
            expect(status.installation).toBeDefined();
            expect(status.upload).toBeDefined();
        });
    });
});
