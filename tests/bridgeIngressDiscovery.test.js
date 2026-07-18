jest.mock('../src/ingressDiscovery');

const { discoverIngressEntry } = require('../src/ingressDiscovery');
const CgateWebBridge = require('../src/cgateWebBridge');
const WebServer = require('../src/webServer');

/**
 * Wiring tests for GitHub #33: the bridge must learn the HA ingress entry path
 * from the Supervisor API and hand it to the web server, with INGRESS_ENTRY
 * remaining an explicit override. The method is invoked with a minimal fake
 * bridge context so no sockets are opened.
 */
describe('CgateWebBridge._discoverIngressBasePath (GitHub #33)', () => {
    let webServer;
    let fakeBridge;
    let savedEnv;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        savedEnv = { INGRESS_ENTRY: process.env.INGRESS_ENTRY, SUPERVISOR_TOKEN: process.env.SUPERVISOR_TOKEN };
        delete process.env.INGRESS_ENTRY;
        delete process.env.SUPERVISOR_TOKEN;
        discoverIngressEntry.mockReset();

        webServer = new WebServer({ port: 0, labelLoader: {}, getStatus: () => ({}) });
        fakeBridge = {
            webServer,
            logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
            _discoverIngressBasePath: CgateWebBridge.prototype._discoverIngressBasePath
        };
    });

    afterEach(() => {
        if (savedEnv.INGRESS_ENTRY === undefined) delete process.env.INGRESS_ENTRY;
        else process.env.INGRESS_ENTRY = savedEnv.INGRESS_ENTRY;
        if (savedEnv.SUPERVISOR_TOKEN === undefined) delete process.env.SUPERVISOR_TOKEN;
        else process.env.SUPERVISOR_TOKEN = savedEnv.SUPERVISOR_TOKEN;
        jest.restoreAllMocks();
    });

    it('applies the discovered ingress entry as the web server base path', async () => {
        process.env.SUPERVISOR_TOKEN = 'tok';
        discoverIngressEntry.mockResolvedValue('/api/hassio_ingress/discovered123');

        await fakeBridge._discoverIngressBasePath();

        expect(discoverIngressEntry).toHaveBeenCalledWith({ token: 'tok' });
        expect(webServer.basePath).toBe('/api/hassio_ingress/discovered123');
    });

    it('keeps an explicit INGRESS_ENTRY override and skips the Supervisor lookup', async () => {
        process.env.INGRESS_ENTRY = '/api/hassio_ingress/override';
        process.env.SUPERVISOR_TOKEN = 'tok';

        const result = await fakeBridge._discoverIngressBasePath();

        expect(result).toBeNull();
        expect(discoverIngressEntry).not.toHaveBeenCalled();
        expect(webServer.basePath).toBe('');
    });

    it('does nothing outside the add-on environment (no SUPERVISOR_TOKEN)', async () => {
        const result = await fakeBridge._discoverIngressBasePath();

        expect(result).toBeNull();
        expect(discoverIngressEntry).not.toHaveBeenCalled();
        expect(webServer.basePath).toBe('');
    });

    it('warns with a web_api_key hint when discovery fails, leaving requests denied', async () => {
        process.env.SUPERVISOR_TOKEN = 'tok';
        discoverIngressEntry.mockResolvedValue(null);

        await fakeBridge._discoverIngressBasePath();

        expect(webServer.basePath).toBe('');
        expect(fakeBridge.logger.warn).toHaveBeenCalledWith(expect.stringContaining('web_api_key'));
    });

    it('logs a warning instead of throwing when discovery itself errors', async () => {
        process.env.SUPERVISOR_TOKEN = 'tok';
        discoverIngressEntry.mockRejectedValue(new Error('boom'));

        await expect(fakeBridge._discoverIngressBasePath()).resolves.toBeUndefined();

        expect(webServer.basePath).toBe('');
        expect(fakeBridge.logger.warn).toHaveBeenCalledWith(expect.stringContaining('web_api_key'));
    });
});
