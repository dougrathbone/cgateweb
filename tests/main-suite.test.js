// tests/index.test.js

// --- Mock Dependencies ---
jest.mock('net');
jest.mock('fs');
jest.mock('xml2js', () => ({ // Mock xml2js
    parseString: jest.fn()
}));


// Import events before mocks that use it
const EventEmitter = require('events');

// --- Mock Implementations ---

// Mock MQTT Client instance
const mockMqttClient = new EventEmitter();
mockMqttClient.publish = jest.fn();
mockMqttClient.subscribe = jest.fn((topic, cb) => { if (cb) { setTimeout(() => cb(null), 0); } return mockMqttClient; });
mockMqttClient.end = jest.fn((force, cb) => { setTimeout(() => { mockMqttClient.emit('close'); if (cb) cb(); }, 0); }); // Emit close on end
mockMqttClient.connected = false; // Initial state for mock

// Mock the MQTT module itself
jest.mock('mqtt', () => ({
    createClient: jest.fn().mockReturnValue(mockMqttClient)
}));

// Factory for net.Socket to return new mocks each time
const net = require('net'); // Require net for the prototype
const createMockSocket = () => {
    const mockSocket = new EventEmitter();
    // Add all methods used by index.js
    mockSocket.connect = jest.fn().mockImplementation((port, host) => { setTimeout(() => mockSocket.emit('connect'), 5); });
    mockSocket.write = jest.fn();
    mockSocket.destroy = jest.fn(() => { setTimeout(() => mockSocket.emit('close', false), 0); }); // Emit close on destroy
    mockSocket.removeAllListeners = jest.fn(EventEmitter.prototype.removeAllListeners);
    mockSocket.on = jest.fn(EventEmitter.prototype.on);
    // Allow emitting events for tests - Use original emit implementation
    // Make emit explicitly use the prototype to avoid jest auto-mocking issues
    mockSocket.emit = EventEmitter.prototype.emit;
    mockSocket.eventNames = jest.fn(EventEmitter.prototype.eventNames);
    mockSocket.listenerCount = jest.fn(EventEmitter.prototype.listenerCount);
    // Add other net.Socket methods if needed by index.js
    mockSocket.unref = jest.fn();
    mockSocket.ref = jest.fn();
    mockSocket.setTimeout = jest.fn();
    return mockSocket;
};
net.Socket = jest.fn().mockImplementation(createMockSocket);


// Mock settings (used by the class constructor)
const mockSettings = {
    mqtt: 'mockbroker:1883',
    cbusip: 'mockhost',
    cbusname: 'mockproject',
    retainreads: true, // Test retain flag
    logging: false, // Keep false for tests
    messageinterval: 10, // Faster interval for testing
    getallnetapp: 'mockApp', // Enable periodic getall for testing
    getallonstart: true,
    getallperiod: 5, // Every 5 seconds (simulated)
    mqttusername: 'user', // Test credentials
    mqttpassword: 'pass'
};
// Mock the settings module load
jest.mock('../settings.js', () => (mockSettings), { virtual: true });

// --- Import Class Under Test ---
// Import after mocks are set up
const CgateWebBridge = require('../index.js'); // Assuming CgateWebBridge is the main export
// Need to check how ThrottledQueue etc. are exported if they are used directly in tests
// For now, let's assume they are defined locally or accessed via the bridge instance

// Define constants locally for tests
const CGATE_COMMAND_PORT = 20023;
const CGATE_EVENT_PORT = 20025;
const MQTT_TOPIC_PREFIX_READ = 'cbus/read';
const MQTT_TOPIC_PREFIX_WRITE = 'cbus/write';
const MQTT_STATE_ON = 'ON';
const MQTT_STATE_OFF = 'OFF';
const RAMP_STEP = 26;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const CGATE_RESPONSE_OBJECT_STATUS = '300';
const CGATE_RESPONSE_TREE_START = '343';
const CGATE_RESPONSE_TREE_END = '344';
const CGATE_RESPONSE_TREE_DATA = '347';


// Mock console methods
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => { });
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => { });
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { });

// Use fake timers
jest.useFakeTimers();

// --- Test Suite ---
describe('CgateWebBridge Class', () => {
    let bridge; // To hold the class instance
    let currentCommandSocketMock; // To hold the specific mock instance for a test
    let currentEventSocketMock; // To hold the specific mock instance for a test

    beforeEach(() => {
        // Reset mocks and timers before each test
        jest.clearAllMocks();
        jest.clearAllTimers();

        // Reset mock states
        mockMqttClient.connected = false;
        mockMqttClient.removeAllListeners(); // Ensure listeners are cleared

        // Clear net.Socket constructor calls, the factory remains
        net.Socket.mockClear();

        // --- Instantiate the class under test with MOCKS ---
        const mockCommandSocketFactory = () => createMockSocket(); // Use our helper
        const mockEventSocketFactory = () => createMockSocket();   // Use our helper
        bridge = new CgateWebBridge(
            mockSettings,
            mockMqttClient, // Inject the mock MQTT client
            mockCommandSocketFactory, // Inject mock factory
            mockEventSocketFactory    // Inject mock factory
        );

        // --- Important: Call start AFTER instantiation ---
        bridge.start();

        // Capture the mock sockets created by startBridge using the injected factories
        currentCommandSocketMock = bridge.commandSocket;
        currentEventSocketMock = bridge.eventSocket;

         // Ensure mocks were captured
         if (!currentCommandSocketMock || !currentEventSocketMock) {
             throw new Error('Failed to capture mock socket instances in beforeEach after injection');
         }
         // Reset console mocks specifically for call counts between tests
         mockConsoleLog.mockClear();
         mockConsoleError.mockClear();
         mockConsoleWarn.mockClear();
    });

    afterEach(() => {
        // Ensure the bridge is stopped and cleaned up
        bridge.stop();
        jest.runOnlyPendingTimers();
        jest.clearAllTimers();
    });

    describe('start', () => {
        it('should initialize queues', () => {
            expect(bridge.mqttPublishQueue).toBeInstanceOf(ThrottledQueue);
            expect(bridge.cgateCommandQueue).toBeInstanceOf(ThrottledQueue);
        });

        it('should create MQTT client and trigger connect', () => {
            const mqtt = require('mqtt');
            expect(mqtt.createClient).toHaveBeenCalledTimes(1);
            expect(mqtt.createClient).toHaveBeenCalledWith('1883', 'mockbroker', { username: 'user', password: 'pass' });
            // Run timers to allow async connect handler to run
            jest.runOnlyPendingTimers();
            expect(bridge.clientConnected).toBe(true); // Check state AFTER handler should have run
        });

        it('should create and trigger connect for command socket', () => {
            expect(net.Socket).toHaveBeenCalledTimes(2);
            expect(currentCommandSocketMock.connect).toHaveBeenCalledTimes(1);
            expect(currentCommandSocketMock.connect).toHaveBeenCalledWith(CGATE_COMMAND_PORT, 'mockhost');
             // Run timers to allow async connect handler to run
            jest.runOnlyPendingTimers();
            expect(bridge.commandConnected).toBe(true);
        });

        it('should create and trigger connect for event socket', () => {
            expect(net.Socket).toHaveBeenCalledTimes(2);
            expect(currentEventSocketMock.connect).toHaveBeenCalledTimes(1);
            expect(currentEventSocketMock.connect).toHaveBeenCalledWith(CGATE_EVENT_PORT, 'mockhost');
             // Run timers to allow async connect handler to run
             jest.runOnlyPendingTimers();
            expect(bridge.eventConnected).toBe(true);
        });

        it('should attach listeners correctly', () => {
             expect(bridge.client.eventNames()).toEqual(expect.arrayContaining(['connect', 'message', 'error', 'close', 'offline', 'reconnect']));
             expect(bridge.commandSocket.removeAllListeners).toHaveBeenCalledTimes(1);
             expect(bridge.commandSocket.eventNames()).toEqual(expect.arrayContaining(['connect', 'data', 'close', 'error']));
             expect(bridge.eventSocket.removeAllListeners).toHaveBeenCalledTimes(1);
             expect(bridge.eventSocket.eventNames()).toEqual(expect.arrayContaining(['connect', 'data', 'close', 'error']));
        });
    });

    describe('stop', () => {
        beforeEach(() => {
             jest.runOnlyPendingTimers(); // allow connections from outer beforeEach
             mockMqttClient.end.mockClear();
             currentCommandSocketMock.destroy.mockClear();
             currentEventSocketMock.destroy.mockClear();
        });

        it('should end MQTT client', () => {
            bridge.stop();
            expect(mockMqttClient.end).toHaveBeenCalledWith(true);
        });

        it('should destroy sockets', () => {
            bridge.stop();
            expect(currentCommandSocketMock.destroy).toHaveBeenCalledTimes(1);
            expect(currentEventSocketMock.destroy).toHaveBeenCalledTimes(1);
        });

        it('should clear queues', () => {
            const spy1 = jest.spyOn(bridge.mqttPublishQueue, 'clear');
            const spy2 = jest.spyOn(bridge.cgateCommandQueue, 'clear');
            bridge.stop();
            expect(spy1).toHaveBeenCalledTimes(1);
            expect(spy2).toHaveBeenCalledTimes(1);
        });

        it('should clear periodic interval if active', () => {
            const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
            // Trigger checkAllConnected to set the interval
            mockMqttClient.emit('connect');
            currentCommandSocketMock.emit('connect');
            currentEventSocketMock.emit('connect');
            jest.runOnlyPendingTimers(); // Allow connect handlers and checkAllConnected

             // Verify interval started (initial GETALL should have been written)
             expect(currentCommandSocketMock.write).toHaveBeenCalledWith('GET //mockproject/mockApp/* level\n');
             currentCommandSocketMock.write.mockClear();

             // Advance time to trigger periodic GETALL
             jest.advanceTimersByTime(5000); // Trigger periodic (settings.getallperiod = 5)
             expect(currentCommandSocketMock.write).toHaveBeenCalledWith('GET //mockproject/mockApp/* level\n');

            bridge.stop();
            expect(clearIntervalSpy).toHaveBeenCalledWith(bridge.periodicGetAllInterval);
            clearIntervalSpy.mockRestore();
        });

        it('should reset state flags', () => {
            // Ensure flags are true first
            mockMqttClient.emit('connect');
            currentCommandSocketMock.emit('connect');
            currentEventSocketMock.emit('connect');
            jest.runOnlyPendingTimers();
            expect(bridge.clientConnected).toBe(true);
            expect(bridge.commandConnected).toBe(true);
            expect(bridge.eventConnected).toBe(true);

            bridge.stop();
            jest.runOnlyPendingTimers(); // Process socket close events

            expect(bridge.clientConnected).toBe(false);
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.eventConnected).toBe(false);
            expect(bridge.internalEventEmitter.listenerCount('level')).toBe(0);
        });
    });

    describe('Event Handlers', () => {
        beforeEach(() => {
            // Ensure connections are established
            mockMqttClient.emit('connect');
            currentCommandSocketMock.emit('connect');
            currentEventSocketMock.emit('connect');
            jest.runOnlyPendingTimers();
            // Clear mocks after setup
            mockConsoleLog.mockClear();
            mockConsoleWarn.mockClear();
            mockConsoleError.mockClear();
            mockMqttClient.publish.mockClear();
            currentCommandSocketMock.write.mockClear();
            jest.clearAllTimers();
        });

        it('handleMqttConnect should subscribe, check connections, and publish hello', () => {
            mockMqttClient.emit('connect');
            jest.runOnlyPendingTimers();

             expect(mockMqttClient.subscribe).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_WRITE}/#`, expect.any(Function));
             // Check exact log message including prefix
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] ALL CONNECTED');
             expect(mockMqttClient.publish).toHaveBeenCalledWith('hello/cgateweb', 'Online', expect.objectContaining({ retain: false }));
        });

        it('handleCommandConnect should send EVENT ON and check connections', () => {
             currentCommandSocketMock.emit('connect');
             jest.runOnlyPendingTimers();

             // Check exact log message including prefix
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] ALL CONNECTED');
             expect(currentCommandSocketMock.write).toHaveBeenCalledWith('EVENT ON\n');
        });


        it('handleMqttClose should set flag and log', () => {
            mockMqttClient.emit('close');
            expect(bridge.clientConnected).toBe(false);
            expect(mockConsoleWarn).toHaveBeenCalledWith('[WARN] MQTT Client Closed. Reconnection handled by library.');
        });

        it('handleCommandClose should set flag and schedule reconnect', () => {
            currentCommandSocketMock.emit('close', false); // hadError = false
            expect(bridge.commandConnected).toBe(false);
            expect(mockConsoleWarn).toHaveBeenCalledWith('[WARN] COMMAND PORT DISCONNECTED');
            // Check exact log message including prefix
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND PORT RECONNECTING in 1s (attempt 1)...');
            expect(setTimeout).toHaveBeenCalledTimes(1);
            expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), RECONNECT_INITIAL_DELAY_MS);
        });

        it('handleEventClose should set flag and schedule reconnect', () => {
            currentEventSocketMock.emit('close', true); // hadError = true
            expect(bridge.eventConnected).toBe(false);
            expect(mockConsoleWarn).toHaveBeenCalledWith('[WARN] EVENT PORT DISCONNECTED with error');
             // Check exact log message including prefix
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] EVENT PORT RECONNECTING in 1s (attempt 1)...');
             expect(setTimeout).toHaveBeenCalledTimes(1);
             expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), RECONNECT_INITIAL_DELAY_MS);
        });

        it('handleMqttError should log error and set flag', () => {
            const err = new Error('mqtt test');
            mockMqttClient.emit('error', err);
             // Check exact log message including prefix
             expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] MQTT Client Error:', err);
             expect(bridge.clientConnected).toBe(false);
        });

        it('handleCommandError should log error', () => {
            const err = new Error('command test');
            currentCommandSocketMock.emit('error', err);
            // Check exact log message including prefix
            expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] C-Gate Command Socket Error:', err);
        });

        it('handleEventError should log error', () => {
            const err = new Error('event test');
            currentEventSocketMock.emit('error', err);
             // Check exact log message including prefix
             expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] C-Gate Event Socket Error:', err);
        });

        // --- Handler Invocation / Effect Tests ---
        it('handleEventData should ignore comment lines and process others', () => {
            currentEventSocketMock.emit('data', Buffer.from('# This is a comment\nlighting on 1/2/4\n'));
            jest.runOnlyPendingTimers(); // Process queue
            // Check exact log message including prefix
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Ignoring comment from event port:', '# This is a comment');
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2); // state + level
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/1/2/4/state`, MQTT_STATE_ON, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/1/2/4/level`, '100', { retain: true });
        });
    });

    // --- Specific Logic Tests ---
    describe('MQTT Command Handling', () => {
        beforeEach(() => {
            // Ensure connected state
            mockMqttClient.emit('connect');
            currentCommandSocketMock.emit('connect');
            currentEventSocketMock.emit('connect');
            jest.runOnlyPendingTimers(); // process connect logic + initial commands
            // Clear mocks *after* setup is complete and initial commands have run
            currentCommandSocketMock.write.mockClear();
        });

        it('should queue C-Gate ON command for MQTT switch ON', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56/10/switch`, Buffer.from(MQTT_STATE_ON));
            jest.runOnlyPendingTimers(); // Process queue
             // Check the specific call, ignore initial setup calls
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith(`ON //mockproject/254/56/10\n`);
        });

        it('should queue C-Gate OFF command for MQTT switch OFF', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56/11/switch`, Buffer.from(MQTT_STATE_OFF));
            jest.runOnlyPendingTimers(); // Process queue
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith(`OFF //mockproject/254/56/11\n`);
        });

        it('should queue C-Gate RAMP command for MQTT ramp level', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56/12/ramp`, Buffer.from('50')); // 50%
            jest.runOnlyPendingTimers(); // Process queue
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith(expect.stringContaining(`RAMP //mockproject/254/56/12 128`));
        });

        it('should queue C-Gate RAMP command for MQTT ramp level,time', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56/13/ramp`, Buffer.from('75,5s')); // 75%
            jest.runOnlyPendingTimers(); // Process queue
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith(expect.stringContaining(`RAMP //mockproject/254/56/13 191 5s\n`));
        });

        it('should queue GET and listen for level for MQTT ramp INCREASE/DECREASE', () => {
            const getCurrentLevel = 100;
            const emitter = bridge.internalEventEmitter;
            const listenerCountBefore = emitter.listenerCount('level');

            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56/14/ramp`, Buffer.from('INCREASE'));
            jest.runOnlyPendingTimers(); // Process queue (queues GET command)

            expect(currentCommandSocketMock.write).toHaveBeenCalledWith('GET //mockproject/254/56/14 level\n');
            expect(emitter.listenerCount('level')).toBe(listenerCountBefore + 1);

            // Simulate level response via C-Gate data triggering internal emitter
            currentCommandSocketMock.emit('data', Buffer.from(`300 //mockproject/254/56/14 level=${getCurrentLevel}\n`));
            jest.runOnlyPendingTimers(); // Process command data handler + resulting queue item (RAMP)

            const expectedLevel = Math.min(255, getCurrentLevel + RAMP_STEP);
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith(`RAMP //mockproject/254/56/14 ${expectedLevel}\n`);
            expect(emitter.listenerCount('level')).toBe(listenerCountBefore); // Listener should be removed
        });

        it('should queue TREEXML command for MQTT gettree', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254///gettree`, Buffer.from(''));
            jest.runOnlyPendingTimers();
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith('TREEXML 254\n');
        });

        it('should queue GET command for MQTT getall', () => {
            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/254/56//getall`, Buffer.from(''));
            jest.runOnlyPendingTimers();
            expect(currentCommandSocketMock.write).toHaveBeenCalledWith('GET //mockproject/254/56/* level\n');
        });
    });

    // --- C-Gate Data Handling Tests ---
    describe('C-Gate Data Handling', () => {
        beforeEach(() => {
            // Ensure connected state
            mockMqttClient.emit('connect');
            currentCommandSocketMock.emit('connect');
            currentEventSocketMock.emit('connect');
            jest.runOnlyPendingTimers();
            bridge.mqttPublishQueue.clear(); // Clear initial hello
            mockMqttClient.publish.mockClear();
        });

        it('should publish state and level from event data (lighting on)', () => {
            currentEventSocketMock.emit('data', Buffer.from('lighting on 254/56/5\n'));
            jest.runOnlyPendingTimers(); // Process queue
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/5/state`, MQTT_STATE_ON, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/5/level`, '100', { retain: true });
        });

        it('should publish state and level from event data (lighting off)', () => {
            currentEventSocketMock.emit('data', Buffer.from('lighting off 254/56/6\n'));
            jest.runOnlyPendingTimers(); // Process queue
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/6/state`, MQTT_STATE_OFF, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/6/level`, '0', { retain: true });
        });

        it('should publish state and level from event data (lighting ramp)', () => {
            currentEventSocketMock.emit('data', Buffer.from('lighting ramp 254/56/7 128\n')); // 128 = 50%
            jest.runOnlyPendingTimers(); // Process queue
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/7/state`, MQTT_STATE_ON, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/7/level`, '50', { retain: true }); // 50% approx
        });

        it('should publish state and level from command data (300 level=)', () => {
            currentCommandSocketMock.emit('data', Buffer.from(`300 //mockproject/254/56/8 level=77\n`)); // 77/255 = ~30%
            jest.runOnlyPendingTimers(); // Process queue
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/8/state`, MQTT_STATE_ON, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/8/level`, '30', { retain: true }); // Approx 30%
        });

        it('should publish state and level from command data (300-lighting on)', () => {
            currentCommandSocketMock.emit('data', Buffer.from(`300-lighting on 254/56/9\n`));
            jest.runOnlyPendingTimers(); // Process queue
            expect(mockMqttClient.publish).toHaveBeenCalledTimes(2);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/9/state`, MQTT_STATE_ON, { retain: true });
            expect(mockMqttClient.publish).toHaveBeenCalledWith(`${MQTT_TOPIC_PREFIX_READ}/254/56/9/level`, '100', { retain: true });
        });

        // Test TreeXML processing
        it('should assemble and publish TreeXML data', () => {
            // Mock parseString to immediately call back
            const mockXml2js = require('xml2js');
             const mockParsedResult = { NodeList: { Unit: [{ '$': { address: '1', catalog: 'L5504AMP' } }] } };
             mockXml2js.parseString.mockImplementation((xml, cb) => {
                  setTimeout(() => cb(null, mockParsedResult), 0); // Simulate async callback
              });

            const network = '254';
            const xmlData = '<NodeList><Unit address="1" catalog="L5504AMP"/></NodeList>';
            const treeStart = CGATE_RESPONSE_TREE_START; // 343
            const treeData = CGATE_RESPONSE_TREE_DATA;  // 347
            const treeEnd = CGATE_RESPONSE_TREE_END;    // 344

            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/${network}///gettree`, Buffer.from(''));
            jest.runOnlyPendingTimers();
            currentCommandSocketMock.write.mockClear();

            currentCommandSocketMock.emit('data', Buffer.from(`${treeStart}-${network}\n`));
            currentCommandSocketMock.emit('data', Buffer.from(`${treeData}-${xmlData}\n`));
            currentCommandSocketMock.emit('data', Buffer.from(`${treeEnd}-${network}\n`));

            expect(mockXml2js.parseString).toHaveBeenCalledWith(xmlData+'\n', expect.any(Function));
            // Use runOnlyPendingTimers() - Should process async parseString callback + MQTT publish queue timer
            jest.runOnlyPendingTimers();

            expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
            expect(mockMqttClient.publish).toHaveBeenCalledWith(
                `${MQTT_TOPIC_PREFIX_READ}/${network}///tree`,
                JSON.stringify(mockParsedResult),
                { retain: true }
            );
        });

        it('should log error on malformed command data', () => {
            currentCommandSocketMock.emit('data', Buffer.from('This is not valid C-Gate data\n'));
            // Check exact log message including prefix
            expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] Error parsing C-Gate command data line: "This is not valid C-Gate data" ->', expect.any(Error));
        });

        it('should log error on malformed event data', () => {
            currentEventSocketMock.emit('data', Buffer.from('This is not valid C-Gate event data\n'));
             // Check exact log message including prefix
             expect(mockConsoleError).toHaveBeenCalledWith('[ERROR] Error parsing C-Gate event data line: "This is not valid C-Gate event data" ->', expect.any(Error));
        });

         it('should handle TreeXML parsing errors', () => {
            const mockXml2js = require('xml2js');
            const parseError = new Error('XML Parse Error');
            mockXml2js.parseString.mockImplementation((xml, cb) => {
                 setTimeout(() => cb(parseError), 0); // Simulate async callback
             });

            const network = '254';
            const treeEnd = CGATE_RESPONSE_TREE_END;

            mockMqttClient.emit('message', `${MQTT_TOPIC_PREFIX_WRITE}/${network}///gettree`, Buffer.from(''));
            jest.runOnlyPendingTimers();

            currentCommandSocketMock.emit('data', Buffer.from(`${treeEnd}-${network}\n`));
             // Use runOnlyPendingTimers() here as well
            jest.runOnlyPendingTimers(); // Process parseString callback

            expect(mockConsoleError).toHaveBeenCalledWith("[ERROR] Error parsing C-Bus tree XML:", parseError);
            expect(mockMqttClient.publish).not.toHaveBeenCalled(); // Shouldn't publish on error
         });

    });

     // --- Reconnection Tests (using new setup) ---
    describe('C-Gate Reconnection Logic (Revised Tests)', () => {
        let initialCommandSocket;

         beforeEach(() => {
             initialCommandSocket = bridge.commandSocket;
             mockConsoleLog.mockClear();
             net.Socket.mockClear();
         });


        it('should attempt to reconnect command socket on close with initial delay', () => {
            initialCommandSocket.emit('close');
            // Check exact log message including prefix
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND PORT RECONNECTING in 1s (attempt 1)...');

            // Advance timer - this triggers connectCommandSocket() which calls new net.Socket()
            jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS);

            // Expect net.Socket to have been called again for the reconnect attempt
            expect(net.Socket).toHaveBeenCalledTimes(1); // Only the reconnect attempt expected here
            const newCommandSocket = net.Socket.mock.results[0].value; // Get the *newly created* mock
            expect(newCommandSocket).toBeDefined();
            expect(newCommandSocket.connect).toHaveBeenCalledTimes(1);
        });

        it('should increase reconnect delay exponentially', () => {
             initialCommandSocket.emit('close'); // Close 1
             jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS); // Reconnect attempt 1 (delay 1s) -> creates 1st new socket
             expect(net.Socket).toHaveBeenCalledTimes(1); // 1st reconnect attempt
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Attempting reconnect command socket to mockhost:20023');
             const secondReconnectSocket = net.Socket.mock.results[0].value;

             secondReconnectSocket.emit('close'); // Close 2
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND PORT RECONNECTING in 2s (attempt 2)...');
             jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS * 2); // Reconnect attempt 2 (delay 2s) -> creates 2nd new socket
             expect(net.Socket).toHaveBeenCalledTimes(2); // 2nd reconnect attempt
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Attempting reconnect command socket to mockhost:20023');
             const thirdReconnectSocket = net.Socket.mock.results[1].value;

             thirdReconnectSocket.emit('close'); // Close 3
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND PORT RECONNECTING in 4s (attempt 3)...');
             jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS * 4); // Reconnect attempt 3 (delay 4s) -> creates 3rd new socket
             expect(net.Socket).toHaveBeenCalledTimes(3); // 3 reconnect attempts
             expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] Attempting reconnect command socket to mockhost:20023');
         });

         it('should reset reconnect attempts on successful connect', () => {
            initialCommandSocket.emit('close'); // Close 1
            jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS); // Reconnect attempt 1 (1s) -> creates 1st new socket
            expect(net.Socket).toHaveBeenCalledTimes(1);
            const secondSocket = net.Socket.mock.results[0].value;

            secondSocket.emit('close'); // Close 2
            jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS * 2); // Reconnect attempt 2 (2s) -> creates 2nd new socket
            expect(net.Socket).toHaveBeenCalledTimes(2);
            const thirdSocket = net.Socket.mock.results[1].value; // This is the socket currently trying to connect
            expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('(attempt 2)...'));

            // Simulate successful connect on the third socket
            thirdSocket.emit('connect'); // This triggers handleCommandConnect -> resetReconnectDelay
            jest.runOnlyPendingTimers(); // Allow connect handler logic to run
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND reconnect attempts reset.');

            // Now simulate another close on the currently active socket (thirdSocket)
            thirdSocket.emit('close');
            // Delay should be reset to initial value (1s), attempt count back to 1
            expect(mockConsoleLog).toHaveBeenCalledWith('[INFO] COMMAND PORT RECONNECTING in 1s (attempt 1)...');
            jest.advanceTimersByTime(RECONNECT_INITIAL_DELAY_MS); // -> creates 3rd new socket
            expect(net.Socket).toHaveBeenCalledTimes(3); // 3 reconnect attempts total
            const fourthSocket = net.Socket.mock.results[2].value; // Get the socket created by the last reconnect
            expect(fourthSocket).toBeDefined();
            expect(fourthSocket.connect).toHaveBeenCalledTimes(1);
        });
    });

});