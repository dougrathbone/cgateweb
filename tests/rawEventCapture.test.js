const CgateWebBridge = require('../src/cgateWebBridge');

function buildBridge(apps) {
    const published = [];
    const logged = [];
    const bridge = Object.create(CgateWebBridge.prototype);
    bridge.settings = { cbusRawEventLogApps: apps };
    bridge.logger = { info: (m) => logged.push(m), debug: () => {}, warn: () => {} };
    bridge.mqttManager = { publish: (topic, payload, opts) => published.push({ topic, payload, opts }) };
    return { bridge, published, logged };
}

describe('raw event capture', () => {
    it('logs and publishes a verbatim line when its app is configured', () => {
        const { bridge, published, logged } = buildBridge(['172']);
        bridge.publishRawEventCapture('someappevent 254/172/1 1 2 3');
        expect(logged.some(l => l.includes('254/172/1 1 2 3'))).toBe(true);
        expect(published).toContainEqual({
            topic: 'cbus/read/254/172/1/raw',
            payload: 'someappevent 254/172/1 1 2 3',
            opts: { retain: false, qos: 0 }
        });
    });

    it('ignores lines whose app is not configured', () => {
        const { bridge, published, logged } = buildBridge(['172']);
        bridge.publishRawEventCapture('lighting on 254/56/4');
        expect(logged.length).toBe(0);
        expect(published.length).toBe(0);
    });

    it('does nothing when the capture list is empty', () => {
        const { bridge, published, logged } = buildBridge([]);
        bridge.publishRawEventCapture('someappevent 254/172/1 9');
        expect(logged.length).toBe(0);
        expect(published.length).toBe(0);
    });

    it('matches app IDs regardless of string/number type in the config', () => {
        const { bridge, published } = buildBridge([172]); // numeric config entry
        bridge.publishRawEventCapture('temperature 254/172/3 86');
        expect(published.length).toBe(1);
    });

    it('handles a line with no net/app/group token gracefully', () => {
        const { bridge, published } = buildBridge(['172']);
        bridge.publishRawEventCapture('garbage line with no address');
        expect(published.length).toBe(0);
    });
});
