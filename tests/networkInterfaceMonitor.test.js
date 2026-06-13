const { NetworkInterfaceMonitor } = require('../src/networkInterfaceMonitor');

function mkLogger() {
    return { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

describe('NetworkInterfaceMonitor', () => {
    let logger;
    let clock;
    let monitor;

    beforeEach(() => {
        logger = mkLogger();
        clock = 1000;
        monitor = new NetworkInterfaceMonitor({ logger, now: () => clock });
    });

    it('marks a network online when InterfaceState=running (no spurious log on first reading)', () => {
        monitor.update('254', { interfaceState: 'running' });
        const snap = monitor.getSnapshot();
        expect(snap).toHaveLength(1);
        expect(snap[0]).toMatchObject({ network: '254', interfaceState: 'running', online: true });
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
        expect(monitor.hasOutage()).toBe(false);
    });

    it('marks a network offline and logs a warning when the CNI drops', () => {
        monitor.update('254', { interfaceState: 'running' });
        clock = 2000;
        monitor.update('254', { interfaceState: 'closed' });
        const snap = monitor.getSnapshot();
        expect(snap[0]).toMatchObject({ network: '254', interfaceState: 'closed', online: false });
        expect(snap[0].since).toBe(2000); // transition timestamp updated
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toMatch(/network 254 interface DOWN/i);
        expect(monitor.hasOutage()).toBe(true);
    });

    it('treats opening/closing/streamsclosed as offline', () => {
        for (const s of ['opening', 'closing', 'streamsclosed']) {
            const m = new NetworkInterfaceMonitor({ logger: mkLogger(), now: () => 1 });
            m.update('254', { interfaceState: s });
            expect(m.getSnapshot()[0].online).toBe(false);
        }
    });

    it('logs a recovery info message on offline→online transition', () => {
        monitor.update('254', { interfaceState: 'closed' });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        clock = 3000;
        monitor.update('254', { interfaceState: 'running' });
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info.mock.calls[0][0]).toMatch(/restored/i);
        expect(monitor.getSnapshot()[0].online).toBe(true);
    });

    it('does not re-log when state is unchanged across polls', () => {
        monitor.update('254', { interfaceState: 'closed' });
        monitor.update('254', { interfaceState: 'closed' });
        monitor.update('254', { interfaceState: 'closed' });
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('updates lastChecked on every reading even when unchanged', () => {
        monitor.update('254', { interfaceState: 'running' });
        clock = 5000;
        monitor.update('254', { interfaceState: 'running' });
        expect(monitor.getSnapshot()[0].lastChecked).toBe(5000);
    });

    it('records State without flipping the online verdict derived from InterfaceState', () => {
        monitor.update('254', { interfaceState: 'running' });
        monitor.update('254', { state: 'ok' });
        const snap = monitor.getSnapshot()[0];
        expect(snap.state).toBe('ok');
        expect(snap.online).toBe(true); // unchanged by a State-only reading
    });

    it('tracks multiple networks independently', () => {
        monitor.update('254', { interfaceState: 'running' });
        monitor.update('250', { interfaceState: 'closed' });
        const byId = Object.fromEntries(monitor.getSnapshot().map(s => [s.network, s.online]));
        expect(byId).toEqual({ '254': true, '250': false });
        expect(monitor.hasOutage()).toBe(true);
    });
});
