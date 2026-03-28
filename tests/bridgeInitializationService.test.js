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
        autoDiscoverNetworks: false, // disabled by default so existing tests don't need async handling
        ...settingsOverrides
    };

    const mqttPublish = jest.fn();
    const commandQueueAdd = jest.fn();
    const labelLoaderGetLabelData = jest.fn(() => ({ labels: new Map() }));
    const labelLoaderOn = jest.fn();
    const labelLoaderRemoveListener = jest.fn();
    const labelLoaderWatch = jest.fn();
    const labelLoaderUnwatch = jest.fn();

    const commandResponseProcessor = {
        networkDiscoveryHandler: null,
        haDiscovery: null
    };

    const bridge = {
        settings,
        _lastInitTime: 0,
        periodicGetAllInterval: null,
        _onLabelsChanged: null,
        haDiscovery: null,
        discoveredNetworks: null,
        commandResponseProcessor,
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
    return { bridge, commandQueueAdd, mqttPublish, commandResponseProcessor };
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

        it('uses discoveredNetworks when getall_networks is not configured', () => {
            const { bridge } = makeBridge({});
            bridge.discoveredNetworks = [254, 1];
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual(['254/56', '1/56']);
        });

        it('explicit getall_networks overrides discoveredNetworks', () => {
            const { bridge } = makeBridge({ getall_networks: [100] });
            bridge.discoveredNetworks = [254, 1];
            const svc = new BridgeInitializationService(bridge);
            expect(svc._resolveGetallNetworks()).toEqual(['100/56']);
        });
    });

    describe('_discoverNetworks', () => {
        it('parses network IDs from tree response lines and stores on bridge', async () => {
            const { bridge, commandQueueAdd } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();

            // Simulate C-Gate responses from the handler set by _discoverNetworks
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;
            expect(handler).toBeInstanceOf(Function);

            handler('200', '//HOME/254');
            handler('200', '//HOME/1');
            handler('200', 'OK');  // non-matching line, should be ignored

            // Advance timers to trigger timeout/finish
            jest.advanceTimersByTime(6000);
            await promise;

            expect(bridge.discoveredNetworks).toEqual([254, 1]);
            expect(commandQueueAdd).toHaveBeenCalledWith('tree //HOME\n');
        });

        it('ignores non-network lines in the tree response', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;

            handler('200', '//HOME/254');
            handler('200', '//HOME/254/56');   // sub-path, not a network root
            handler('200', '//OTHER/254');     // different project
            handler('200', '//HOME/notanumber'); // non-numeric

            jest.advanceTimersByTime(6000);
            await promise;

            expect(bridge.discoveredNetworks).toEqual([254]);
        });

        it('deduplicates duplicate network IDs', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;

            handler('200', '//HOME/254');
            handler('200', '//HOME/254'); // duplicate

            jest.advanceTimersByTime(6000);
            await promise;

            expect(bridge.discoveredNetworks).toEqual([254]);
        });

        it('sets discoveredNetworks to null and warns when no networks found', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;

            handler('200', 'OK');  // no matching lines

            jest.advanceTimersByTime(6000);
            await promise;

            expect(bridge.discoveredNetworks).toBeNull();
        });

        it('finishes early on C-Gate error response', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;

            handler('200', '//HOME/254');
            handler('400', 'Bad Request');  // error response triggers early finish

            await promise;

            // Should have parsed what was collected before the error
            expect(bridge.discoveredNetworks).toEqual([254]);
            // Handler should be cleared
            expect(bridge.commandResponseProcessor.networkDiscoveryHandler).toBeNull();
        });

        it('resolves after timeout even if no terminating response', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            const handler = bridge.commandResponseProcessor.networkDiscoveryHandler;
            handler('200', '//HOME/254');

            // Should not resolve immediately
            expect(bridge.discoveredNetworks).toBeNull();

            jest.advanceTimersByTime(5100);
            await promise;

            expect(bridge.discoveredNetworks).toEqual([254]);
        });

        it('clears networkDiscoveryHandler from processor after finishing', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            const svc = new BridgeInitializationService(bridge);

            const promise = svc._discoverNetworks();
            jest.advanceTimersByTime(6000);
            await promise;

            expect(bridge.commandResponseProcessor.networkDiscoveryHandler).toBeNull();
        });

        it('resolves immediately when commandResponseProcessor is not available', async () => {
            const { bridge } = makeBridge({ cbusname: 'HOME' });
            bridge.commandResponseProcessor = null;
            const svc = new BridgeInitializationService(bridge);

            await expect(svc._discoverNetworks()).resolves.toBeUndefined();
        });
    });

    describe('handleAllConnected', () => {
        it('skips re-initialization within 10s debounce window', async () => {
            const { bridge } = makeBridge({ getallonstart: true, getall_networks: [254] });
            bridge._lastInitTime = Date.now();
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge._updateBridgeReadiness).not.toHaveBeenCalled();
        });

        it('queues getall commands for each network on startup', async () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: true,
                getall_networks: [254, 1]
            });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(commandQueueAdd).toHaveBeenCalledTimes(2);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('//HOME/254/56/*');
            expect(commandQueueAdd.mock.calls[1][0]).toContain('//HOME/1/56/*');
        });

        it('queues getall command for legacy single getallnetapp', async () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: true,
                getallnetapp: '254/56'
            });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(commandQueueAdd).toHaveBeenCalledTimes(1);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('//HOME/254/56/*');
        });

        it('does not queue getall when getallonstart is false', async () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: false,
                getall_networks: [254]
            });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(commandQueueAdd).not.toHaveBeenCalled();
        });

        it('sets up periodic getall interval for multiple networks', async () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: false,
                getallperiod: 3600,
                getall_networks: [254, 1]
            });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBeNull();

            jest.advanceTimersByTime(3600 * 1000);
            expect(commandQueueAdd).toHaveBeenCalledTimes(2);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('254/56');
            expect(commandQueueAdd.mock.calls[1][0]).toContain('1/56');

            clearInterval(bridge.periodicGetAllInterval);
        });

        it('clears previous periodic interval before setting a new one', async () => {
            const { bridge } = makeBridge({
                getallonstart: false,
                getallperiod: 3600,
                getall_networks: [254]
            });
            const oldInterval = setInterval(() => {}, 99999);
            bridge.periodicGetAllInterval = oldInterval;
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBe(oldInterval);
            clearInterval(bridge.periodicGetAllInterval);
        });

        it('initializes HaDiscovery and sets up labels listener on first call', async () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(HaDiscovery).toHaveBeenCalledTimes(1);
            expect(bridge.labelLoader.on).toHaveBeenCalledWith('labels-changed', expect.any(Function));
            expect(bridge.labelLoader.watch).toHaveBeenCalled();
            expect(bridge.haDiscovery.trigger).toHaveBeenCalled();
        });

        it('does not re-create HaDiscovery on subsequent calls', async () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: false });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            bridge._lastInitTime = 0;
            await svc.handleAllConnected();
            expect(HaDiscovery).toHaveBeenCalledTimes(1);
        });

        it('calls _updateBridgeReadiness', async () => {
            const { bridge } = makeBridge();
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge._updateBridgeReadiness).toHaveBeenCalledWith('all-connected');
        });

        it('passes working publish callback to HaDiscovery', async () => {
            const { bridge, mqttPublish } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            const [, publishFn] = HaDiscovery.mock.calls[0];
            publishFn('topic/x', 'payload', { retain: true });
            expect(mqttPublish).toHaveBeenCalledWith('topic/x', 'payload', { retain: true });
        });

        it('passes working command callback to HaDiscovery', async () => {
            const { bridge, commandQueueAdd } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            const [, , commandFn] = HaDiscovery.mock.calls[0];
            commandFn('GET //HOME/254/56/* level');
            expect(commandQueueAdd).toHaveBeenCalledWith('GET //HOME/254/56/* level', { priority: 'bulk' });
        });

        it('invokes haDiscovery.updateLabels and trigger when labels change', async () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: true });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            const labelData = { labels: new Map([['key', 'val']]) };
            bridge._onLabelsChanged(labelData);
            expect(bridge.haDiscovery.updateLabels).toHaveBeenCalledWith(labelData);
            expect(bridge.haDiscovery.trigger).toHaveBeenCalledTimes(2); // once on connect, once on labels change
        });

        it('passes discoveredNetworks to haDiscovery.trigger', async () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: true });
            bridge.discoveredNetworks = [254, 1];
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge.haDiscovery.trigger).toHaveBeenCalledWith([254, 1]);
        });

        it('calls _discoverNetworks when autoDiscoverNetworks is true', async () => {
            const { bridge } = makeBridge({
                autoDiscoverNetworks: true,
                cbusname: 'HOME'
            });
            const svc = new BridgeInitializationService(bridge);
            const discoverSpy = jest.spyOn(svc, '_discoverNetworks').mockResolvedValue(undefined);
            await svc.handleAllConnected();
            expect(discoverSpy).toHaveBeenCalled();
        });

        it('does not call _discoverNetworks when autoDiscoverNetworks is false', async () => {
            const { bridge } = makeBridge({ autoDiscoverNetworks: false });
            const svc = new BridgeInitializationService(bridge);
            const discoverSpy = jest.spyOn(svc, '_discoverNetworks').mockResolvedValue(undefined);
            await svc.handleAllConnected();
            expect(discoverSpy).not.toHaveBeenCalled();
        });

        it('uses discoveredNetworks for getall when getall_networks is not configured', async () => {
            const { bridge, commandQueueAdd } = makeBridge({
                getallonstart: true,
                // no getall_networks
            });
            bridge.discoveredNetworks = [254];
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(commandQueueAdd).toHaveBeenCalledTimes(1);
            expect(commandQueueAdd.mock.calls[0][0]).toContain('//HOME/254/56/*');
        });
    });

    describe('stop', () => {
        it('clears periodic interval on stop', async () => {
            const { bridge } = makeBridge({ getallonstart: false, getallperiod: 3600, getall_networks: [254] });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            expect(bridge.periodicGetAllInterval).not.toBeNull();
            svc.stop();
            expect(bridge.periodicGetAllInterval).toBeNull();
        });

        it('removes labels-changed listener on stop', async () => {
            const { bridge } = makeBridge({ ha_discovery_enabled: false });
            const svc = new BridgeInitializationService(bridge);
            await svc.handleAllConnected();
            const listener = bridge._onLabelsChanged;
            svc.stop();
            expect(bridge.labelLoader.removeListener).toHaveBeenCalledWith('labels-changed', listener);
            expect(bridge._onLabelsChanged).toBeNull();
        });

        it('calls labelLoader.unwatch on stop', async () => {
            const { bridge } = makeBridge();
            const svc = new BridgeInitializationService(bridge);
            svc.stop();
            expect(bridge.labelLoader.unwatch).toHaveBeenCalled();
        });
    });
});
