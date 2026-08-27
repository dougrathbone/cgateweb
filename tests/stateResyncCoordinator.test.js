const StateResyncCoordinator = require('../src/stateResyncCoordinator');

describe('StateResyncCoordinator', () => {
    let settings;
    let commandQueue;
    let haDiscovery;
    let initializationService;
    let logger;
    let coordinator;

    beforeEach(() => {
        jest.useFakeTimers();
        settings = {
            cbusname: 'TEST',
            stateResyncOnHaRestart: true,
            stateResyncOnMqttReconnect: true,
            stateResyncDebounceMs: 5000
        };
        commandQueue = { add: jest.fn() };
        haDiscovery = {
            republishDiscoveryConfigs: jest.fn().mockReturnValue(3),
            syncUnlistedGroupDiscovery: jest.fn()
        };
        // Stand-in for BridgeInitializationService, which owns both the getall
        // command syntax and the "which networks does security sync" rule.
        initializationService = {
            _resolveGetallNetworks: () => ['254/56', '254/203'],
            sendGetallLevels: jest.fn((netapps, options) => {
                const pairs = netapps || ['254/56', '254/203'];
                for (const netapp of pairs) commandQueue.add(`GET //TEST/${netapp}/* level\n`, options);
                return pairs;
            }),
            sendSecurityStatusRequests: jest.fn(),
            sendClockRefreshRequests: jest.fn()
        };
        logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
        coordinator = new StateResyncCoordinator({
            settings,
            logger,
            getHaDiscovery: () => haDiscovery,
            getInitializationService: () => initializationService
        });
    });

    afterEach(() => {
        coordinator.dispose();
        jest.useRealTimers();
    });

    describe('getall resync', () => {
        it('queues a getall per configured net/app', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).toHaveBeenCalledWith('GET //TEST/254/56/* level\n', { priority: 'bulk' });
            expect(commandQueue.add).toHaveBeenCalledWith('GET //TEST/254/203/* level\n', { priority: 'bulk' });
        });

        it('does nothing until the debounce elapses', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(4999);
            expect(commandQueue.add).not.toHaveBeenCalled();
        });

        it('logs one INFO summary naming the trigger', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ha-birth'));
        });
    });

    describe('debounce', () => {
        it('collapses two triggers inside the window into one resync', () => {
            coordinator.requestResync('ha-birth');
            coordinator.requestResync('mqtt-reconnect');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).toHaveBeenCalledTimes(2); // 2 net/apps, once each
        });

        it('allows a later resync after the window closes', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            commandQueue.add.mockClear();
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).toHaveBeenCalledTimes(2);
        });
    });

    describe('discovery republish', () => {
        it('is skipped for an HA birth, whose retained configs survived', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(haDiscovery.republishDiscoveryConfigs).not.toHaveBeenCalled();
            expect(haDiscovery.syncUnlistedGroupDiscovery).toHaveBeenCalledTimes(1);
        });

        it('runs for a broker reconnect, which may have dropped them', () => {
            coordinator.requestResync('mqtt-reconnect');
            jest.advanceTimersByTime(5000);
            expect(haDiscovery.republishDiscoveryConfigs).toHaveBeenCalledTimes(1);
        });

        it('stays requested when a collapsed trigger asked for it', () => {
            coordinator.requestResync('ha-birth');
            coordinator.requestResync('mqtt-reconnect');
            jest.advanceTimersByTime(5000);
            expect(haDiscovery.republishDiscoveryConfigs).toHaveBeenCalledTimes(1);
        });

        it('survives a missing haDiscovery', () => {
            haDiscovery = null;
            coordinator.requestResync('mqtt-reconnect');
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
            expect(commandQueue.add).toHaveBeenCalled();
        });
    });

    describe('security zones', () => {
        // Security panels don't answer lighting-style getall (spec §5.9), so
        // without this the new zone sensors would go stale across exactly the
        // restart this coordinator exists to fix.
        it('delegates the security sync to the init service, which knows the right networks', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(initializationService.sendSecurityStatusRequests).toHaveBeenCalledWith('resync');
        });

        it('still syncs security when no getall networks are configured', () => {
            initializationService.sendGetallLevels = jest.fn().mockReturnValue([]);
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(initializationService.sendSecurityStatusRequests).toHaveBeenCalledWith('resync');
        });
    });

    describe('clock sensors', () => {
        it('asks the network clock to rebroadcast on the same resync as lighting and security', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(initializationService.sendClockRefreshRequests).toHaveBeenCalledWith({ priority: 'bulk' });
        });

        it('still refreshes the clock when no getall networks are configured', () => {
            initializationService.sendGetallLevels = jest.fn().mockReturnValue([]);
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(initializationService.sendClockRefreshRequests).toHaveBeenCalledWith({ priority: 'bulk' });
        });
    });

    describe('nothing to do', () => {
        it('logs at debug and sends nothing when no networks are configured', () => {
            initializationService.sendGetallLevels = jest.fn().mockReturnValue([]);
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('no getall'));
        });

        // The resync fires from a timer, so a throw here is an uncaught
        // exception that kills the bridge rather than a skipped refresh.
        it('warns instead of throwing when the init service is not available yet', () => {
            initializationService = null;
            coordinator.requestResync('ha-birth');
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('initialization service unavailable'));
        });
    });

    describe('disable flags', () => {
        it('honours stateResyncOnHaRestart', () => {
            settings.stateResyncOnHaRestart = false;
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).not.toHaveBeenCalled();
        });

        it('honours stateResyncOnMqttReconnect', () => {
            settings.stateResyncOnMqttReconnect = false;
            coordinator.requestResync('mqtt-reconnect');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).not.toHaveBeenCalled();
        });

        it('still allows the other trigger when one is disabled', () => {
            settings.stateResyncOnMqttReconnect = false;
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).toHaveBeenCalled();
        });
    });

    describe('dispose', () => {
        it('cancels a pending resync', () => {
            coordinator.requestResync('ha-birth');
            coordinator.dispose();
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).not.toHaveBeenCalled();
        });
    });

    describe('debounceMs of 0', () => {
        it('preserves 0 as immediate (does not fall back to the schema default)', () => {
            settings.stateResyncDebounceMs = 0;
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(0);
            expect(commandQueue.add).toHaveBeenCalled();
        });
    });
});
