'use strict';

jest.mock('../src/haDiscovery');

const BridgeInitializationService = require('../src/bridgeInitializationService');
const HaDiscovery = require('../src/haDiscovery');

function makeBridge(settingsOverrides = {}) {
    const settings = {
        cbusname: 'HOME',
        getallonstart: true,
        getallperiod: 0,
        ha_discovery_enabled: false,
        ...settingsOverrides
    };

    const mqttPublish = jest.fn();
    const commandQueueAdd = jest.fn();
    const labelLoaderGetLabelData = jest.fn(() => ({ labels: new Map() }));
    const labelLoaderOn = jest.fn();
    const labelLoaderRemoveListener = jest.fn();
    const labelLoaderWatch = jest.fn();
    const labelLoaderUnwatch = jest.fn();

    const bridge = {
        settings,
        _lastInitTime: 0,
        periodicGetAllInterval: null,
        _onLabelsChanged: null,
        haDiscovery: null,
        commandResponseProcessor: {},
        log: jest.fn(),
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        mqttManager: { publish: mqttPublish },
        cgateCommandQueue: { add: commandQueueAdd },
        labelLoader: {
            getLabelData: labelLoaderGetLabelData,
            on: labelLoaderOn,
            removeListener: labelLoaderRemoveListener,
            watch: labelLoaderWatch,
            unwatch: labelLoaderUnwatch
        },
        _updateBridgeReadiness: jest.fn()
    };
    return { bridge, commandQueueAdd, mqttPublish };
}

describe('BridgeInitializationService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        HaDiscovery.mockClear();
        HaDiscovery.mockImplementation(() => ({
            trigger: jest.fn(),
            updateLabels: jest.fn()
        }));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('_resolveGetallNetworks', () => {
        it('returns only lighting app when no optional apps are configured', () => {
            const { bridge } = makeBridge({ getall_networks: [254, 1] });
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual(['254/56', '1/56']);
        });

        it('includes cover app for each network when ha_discovery_cover_app_id is set', () => {
            const { bridge } = makeBridge({
                getall_networks: [254],
                ha_discovery_cover_app_id: '203'
            });
            const svc = new BridgeInitializationService(bridge);
            const result = svc._resolveGetallNetworks();
            expect(result).toContain('254/56');
            expect(result).toContain('254/203');
            expect(result).toHaveLength(2);
        });

        it('includes HVAC app for each network when ha_discovery_hvac_app_id is set', () => {
            const { bridge } = makeBridge({
                getall_networks: [254],
                ha_discovery_hvac_app_id: '201'
            });
            const svc = new BridgeInitializationService(bridge);
            const result = svc._resolveGetallNetworks();
            expect(result).toContain('254/56');
            expect(result).toContain('254/201');
            expect(result).toHaveLength(2);
        });

        it('includes trigger, switch, and relay apps when configured', () => {
            const { bridge } = makeBridge({
                getall_networks: [254],
                ha_discovery_trigger_app_id: '202',
                ha_discovery_switch_app_id: '88',
                ha_discovery_relay_app_id: '99'
            });
            const svc = new BridgeInitializationService(bridge);
            const result = svc._resolveGetallNetworks();
            expect(result).toContain('254/56');
            expect(result).toContain('254/202');
            expect(result).toContain('254/88');
            expect(result).toContain('254/99');
            expect(result).toHaveLength(4);
        });

        it('deduplicates app IDs when two settings share the same app ID', () => {
            const { bridge } = makeBridge({
                getall_networks: [254],
                ha_discovery_switch_app_id: '56'  // same as lighting app ID
            });
            const svc = new BridgeInitializationService(bridge);
            const result = svc._resolveGetallNetworks();
            expect(result).toEqual(['254/56']);
        });

        it('includes all configured apps for each network when multiple networks configured', () => {
            const { bridge } = makeBridge({
                getall_networks: [254, 1],
                ha_discovery_cover_app_id: '203'
            });
            const svc = new BridgeInitializationService(bridge);
            const result = svc._resolveGetallNetworks();
            expect(result).toContain('254/56');
            expect(result).toContain('254/203');
            expect(result).toContain('1/56');
            expect(result).toContain('1/203');
            expect(result).toHaveLength(4);
        });

        it('falls back to getallnetapp when getall_networks absent', () => {
            const { bridge } = makeBridge({ getallnetapp: '254/56' });
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual(['254/56']);
        });

        it('returns empty array when neither is set', () => {
            const { bridge } = makeBridge({});
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual([]);
        });

        it('returns empty array when getall_networks is empty', () => {
            const { bridge } = makeBridge({ getall_networks: [] });
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual([]);
        });
    });

    describe('handleAllConnected', () => {
        it('skips re-initialization within 10s debounce window', () => {
            const { bridge } = makeBridge({ getallonstart: true, getall_networks: [254] });
            bridge._lastInitTime = Date.now();
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(bridge._updateBridgeReadiness).not.toHaveBeenCalled();
        });

        it('queues getall commands for each network on startup', () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: true,
                getall_networks: [254, 1]
            });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(commandQueueAdd).toHaveBeenCalledTimes(2);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('//HOME/254/56/*');
            expect(commandQueueAdd.mock.calls[1][0]).toContain('//HOME/1/56/*');
        });

        it('queues getall command for legacy single getallnetapp', () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: true,
                getallnetapp: '254/56'
            });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(commandQueueAdd).toHaveBeenCalledTimes(1);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('//HOME/254/56/*');
        });

        it('does not queue getall when getallonstart is false', () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: false,
                getall_networks: [254]
            });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(commandQueueAdd).not.toHaveBeenCalled();
        });

        it('sets up periodic getall interval for multiple networks', () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: false,
                getallperiod: 3600,
                getall_networks: [254, 1]
            });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBeNull();

            jest.advanceTimersByTime(3600 * 1000);
            expect(commandQueueAdd).toHaveBeenCalledTimes(2);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('254/56');
            expect(commandQueueAdd.mock.calls[1][0]).toContain('1/56');

            clearInterval(bridge.periodicGetAllInterval);
        });

        it('clears previous periodic interval before setting a new one', () => {
            const { bridge } = makeBridge({
                getallonstart: false,
                getallperiod: 3600,
                getall_networks: [254]
            });
            const oldInterval = setInterval(() => {}, 99999);
            bridge.periodicGetAllInterval = oldInterval;
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBe(oldInterval);
            clearInterval(bridge.periodicGetAllInterval);
        });

        it('initializes HaDiscovery and sets up labels listener on first call', () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(HaDiscovery).toHaveBeenCalledTimes(1);
            expect(bridge.labelLoader.on).toHaveBeenCalledWith('labels-changed', expect.any(Function));
            expect(bridge.labelLoader.watch).toHaveBeenCalled();
            expect(bridge.haDiscovery.trigger).toHaveBeenCalled();
        });

        it('does not re-create HaDiscovery on subsequent calls', () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: false });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            bridge._lastInitTime = 0;
            svc.handleAllConnected();
            expect(HaDiscovery).toHaveBeenCalledTimes(1);
        });

        it('calls _updateBridgeReadiness', () => {
            const { bridge } = makeBridge();
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(bridge._updateBridgeReadiness).toHaveBeenCalledWith('all-connected');
        });

        it('passes working publish callback to HaDiscovery', () => {
            const { bridge, mqttPublish } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            const [, publishFn] = HaDiscovery.mock.calls[0];
            publishFn('topic/x', 'payload', { retain: true });
            expect(mqttPublish).toHaveBeenCalledWith('topic/x', 'payload', { retain: true });
        });

        it('passes working command callback to HaDiscovery', () => {
            const { bridge, commandQueueAdd } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            const [, , commandFn] = HaDiscovery.mock.calls[0];
            commandFn('GET //HOME/254/56/* level');
            expect(commandQueueAdd).toHaveBeenCalledWith('GET //HOME/254/56/* level', { priority: 'bulk' });
        });

        it('invokes haDiscovery.updateLabels and trigger when labels change', () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            const labelData = { labels: new Map([['key', 'val']]) };
            bridge._onLabelsChanged(labelData);
            expect(bridge.haDiscovery.updateLabels).toHaveBeenCalledWith(labelData);
            expect(bridge.haDiscovery.trigger).toHaveBeenCalledTimes(2); // once on connect, once on labels change
        });
    });

    describe('stop', () => {
        it('clears periodic interval on stop', () => {
            const { bridge } = makeBridge({ getallonstart: false, getallperiod: 3600, getall_networks: [254] });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBeNull();
            svc.stop();
            expect(bridge.periodicGetAllInterval).toBeNull();
        });

        it('removes labels-changed listener on stop', () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: false });
            const svc = new BridgeInitializationService(bridge);
            svc.handleAllConnected();
            const listener = bridge._onLabelsChanged;
            svc.stop();
            expect(bridge.labelLoader.removeListener).toHaveBeenCalledWith('labels-changed', listener);
            expect(bridge._onLabelsChanged).toBeNull();
        });

        it('calls labelLoader.unwatch on stop', () => {
            const { bridge } = makeBridge();
            const svc = new BridgeInitializationService(bridge);
            svc.stop();
            expect(bridge.labelLoader.unwatch).toHaveBeenCalled();
        });
    });
});
