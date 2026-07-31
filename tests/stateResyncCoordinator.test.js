const StateResyncCoordinator = require('../src/stateResyncCoordinator');

describe('StateResyncCoordinator', () => {
    let settings;
    let commandQueue;
    let haDiscovery;
    let securityEventHandler;
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
        haDiscovery = { republishDiscoveryConfigs: jest.fn().mockReturnValue(3) };
        securityEventHandler = { requestStatusSync: jest.fn() };
        initializationService = { _resolveGetallNetworks: jest.fn().mockReturnValue(['254/56', '254/203']) };
        logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
        coordinator = new StateResyncCoordinator({
            settings,
            commandQueue,
            logger,
            getHaDiscovery: () => haDiscovery,
            getSecurityEventHandler: () => securityEventHandler,
            initializationService
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
            expect(commandQueue.add).toHaveBeenCalledWith('GET //TEST/254/56/* level\n');
            expect(commandQueue.add).toHaveBeenCalledWith('GET //TEST/254/203/* level\n');
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
        });

        it('runs for a broker reconnect, which may have dropped them', () => {
            coordinator.requestResync('mqtt-reconnect', { republishDiscovery: true });
            jest.advanceTimersByTime(5000);
            expect(haDiscovery.republishDiscoveryConfigs).toHaveBeenCalledTimes(1);
        });

        it('stays requested when a collapsed trigger asked for it', () => {
            coordinator.requestResync('ha-birth');
            coordinator.requestResync('mqtt-reconnect', { republishDiscovery: true });
            jest.advanceTimersByTime(5000);
            expect(haDiscovery.republishDiscoveryConfigs).toHaveBeenCalledTimes(1);
        });

        it('survives a missing haDiscovery', () => {
            haDiscovery = null;
            coordinator.requestResync('mqtt-reconnect', { republishDiscovery: true });
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
            expect(commandQueue.add).toHaveBeenCalled();
        });
    });

    describe('security zones', () => {
        // Security panels don't answer lighting-style getall (spec §5.9), so
        // without this the new zone sensors would go stale across exactly the
        // restart this coordinator exists to fix.
        it('requests a security status sync per distinct network', () => {
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(securityEventHandler.requestStatusSync).toHaveBeenCalledTimes(1);
            expect(securityEventHandler.requestStatusSync).toHaveBeenCalledWith('254', 'resync');
        });

        it('survives a missing security handler', () => {
            securityEventHandler = null;
            coordinator.requestResync('ha-birth');
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
        });
    });

    describe('nothing to do', () => {
        it('logs at debug and sends nothing when no networks are configured', () => {
            initializationService._resolveGetallNetworks.mockReturnValue([]);
            coordinator.requestResync('ha-birth');
            jest.advanceTimersByTime(5000);
            expect(commandQueue.add).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('no getall'));
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
});
