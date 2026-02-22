const DeviceStateManager = require('../src/deviceStateManager');
const CBusEvent = require('../src/cbusEvent');
const {
    MQTT_TOPIC_SUFFIX_LEVEL,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX
} = require('../src/constants');

describe('DeviceStateManager', () => {
    let stateManager;
    let mockLogger;
    let mockSettings;

    beforeEach(() => {
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        mockSettings = {
            ha_discovery_pir_app_id: 36
        };

        stateManager = new DeviceStateManager({
            settings: mockSettings,
            logger: mockLogger
        });
    });

    afterEach(() => {
        if (stateManager) {
            stateManager.shutdown();
        }
    });

    describe('constructor', () => {
        it('should initialize with required dependencies', () => {
            expect(stateManager.settings).toBe(mockSettings);
            expect(stateManager.logger).toBe(mockLogger);
            expect(stateManager.getEventEmitter()).toBeDefined();
            expect(stateManager.activeOperations).toBeInstanceOf(Set);
        });

        it('should create default logger if none provided', () => {
            const stateManagerWithoutLogger = new DeviceStateManager({
                settings: mockSettings
            });
            
            expect(stateManagerWithoutLogger.logger).toBeDefined();
            expect(typeof stateManagerWithoutLogger.logger.debug).toBe('function');
            
            stateManagerWithoutLogger.shutdown();
        });

        it('should initialize with empty active operations', () => {
            expect(stateManager.getActiveOperationCount()).toBe(0);
        });
    });

    describe('getEventEmitter', () => {
        it('should return the internal event emitter', () => {
            const emitter = stateManager.getEventEmitter();
            expect(emitter).toBeDefined();
            expect(typeof emitter.on).toBe('function');
            expect(typeof emitter.emit).toBe('function');
        });

        it('should return the same emitter instance on multiple calls', () => {
            const emitter1 = stateManager.getEventEmitter();
            const emitter2 = stateManager.getEventEmitter();
            expect(emitter1).toBe(emitter2);
        });
    });

    describe('updateLevelFromEvent', () => {
        it('should extract level from ramp events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 56,
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', 128);
            expect(mockLogger.debug).toHaveBeenCalledWith('Level update: 254/56/4 = 128');
        });

        it('should extract level from on events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 56,
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => null,
                getAction: () => CGATE_CMD_ON.toLowerCase()
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', CGATE_LEVEL_MAX);
            expect(mockLogger.debug).toHaveBeenCalledWith(`Level update: 254/56/4 = ${CGATE_LEVEL_MAX}`);
        });

        it('should extract level from off events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 56,
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => null,
                getAction: () => CGATE_CMD_OFF.toLowerCase()
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', CGATE_LEVEL_MIN);
            expect(mockLogger.debug).toHaveBeenCalledWith(`Level update: 254/56/4 = ${CGATE_LEVEL_MIN}`);
        });

        it('should ignore PIR sensor events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 36, // PIR app ID
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => null,
                getAction: () => 'on'
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).not.toHaveBeenCalled();
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('should ignore events without level information', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 56,
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => null,
                getAction: () => 'unknown'
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).not.toHaveBeenCalled();
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('should handle level 0 from ramp events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            const mockEvent = {
                getApplication: () => 56,
                getNetwork: () => 254,
                getGroup: () => 4,
                getLevel: () => 0,
                getAction: () => 'ramp'
            };

            stateManager.updateLevelFromEvent(mockEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', 0);
        });
    });

    describe('setupRelativeLevelOperation', () => {
        it('should set up a relative level operation successfully', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            const operationId = stateManager.setupRelativeLevelOperation(address, callback);

            expect(operationId).toBeDefined();
            expect(operationId).toContain(address);
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(true);
            expect(stateManager.getActiveOperationCount()).toBe(1);
        });

        it('should prevent duplicate operations for same address', () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            const address = '254/56/4';

            const operationId1 = stateManager.setupRelativeLevelOperation(address, callback1);
            const operationId2 = stateManager.setupRelativeLevelOperation(address, callback2);

            expect(operationId1).toBeDefined();
            expect(operationId2).toBeNull();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Relative level operation already active for 254/56/4')
            );
            expect(stateManager.getActiveOperationCount()).toBe(1);
        });

        it('should call callback when matching level event is received', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            stateManager.setupRelativeLevelOperation(address, callback);

            // Emit matching level event
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, address, 150);

            expect(callback).toHaveBeenCalledWith(150);
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(false);
            expect(stateManager.getActiveOperationCount()).toBe(0);
        });

        it('should not call callback for non-matching address', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            stateManager.setupRelativeLevelOperation(address, callback);

            // Emit non-matching level event
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/5', 150);

            expect(callback).not.toHaveBeenCalled();
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(true);
        });

        it('should still respond to matching event after non-matching events arrive first', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            stateManager.setupRelativeLevelOperation(address, callback);

            // Emit several non-matching events first
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/5', 150);
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/6', 200);

            expect(callback).not.toHaveBeenCalled();
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(true);

            // Now emit the matching event
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, address, 100);

            expect(callback).toHaveBeenCalledWith(100);
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(false);
        });

        it('should timeout and clean up operation', (done) => {
            const callback = jest.fn();
            const address = '254/56/4';
            const timeout = 100; // Short timeout for test

            stateManager.setupRelativeLevelOperation(address, callback, timeout);

            setTimeout(() => {
                expect(callback).not.toHaveBeenCalled();
                expect(stateManager.isRelativeLevelOperationActive(address)).toBe(false);
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('Timeout waiting for level response from 254/56/4')
                );
                done();
            }, timeout + 50);
        });

        it('should handle multiple operations for different addresses', () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            const address1 = '254/56/4';
            const address2 = '254/56/5';

            stateManager.setupRelativeLevelOperation(address1, callback1);
            stateManager.setupRelativeLevelOperation(address2, callback2);

            expect(stateManager.getActiveOperationCount()).toBe(2);
            expect(stateManager.isRelativeLevelOperationActive(address1)).toBe(true);
            expect(stateManager.isRelativeLevelOperationActive(address2)).toBe(true);

            // Trigger first operation - should not consume second operation's listener
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, address1, 100);

            expect(callback1).toHaveBeenCalledWith(100);
            expect(callback2).not.toHaveBeenCalled();
            expect(stateManager.getActiveOperationCount()).toBe(1);
            expect(stateManager.isRelativeLevelOperationActive(address1)).toBe(false);
            expect(stateManager.isRelativeLevelOperationActive(address2)).toBe(true);

            // Trigger second operation - must still work after first was handled
            stateManager.getEventEmitter().emit(MQTT_TOPIC_SUFFIX_LEVEL, address2, 200);

            expect(callback2).toHaveBeenCalledWith(200);
            expect(stateManager.getActiveOperationCount()).toBe(0);
            expect(stateManager.isRelativeLevelOperationActive(address2)).toBe(false);
        });
    });

    describe('cancelRelativeLevelOperation', () => {
        it('should cancel an active operation', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            stateManager.setupRelativeLevelOperation(address, callback);
            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(true);

            stateManager.cancelRelativeLevelOperation(address);

            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(false);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Cancelled relative level operation for 254/56/4'
            );
        });

        it('should handle cancelling non-existent operation gracefully', () => {
            const address = '254/56/4';

            stateManager.cancelRelativeLevelOperation(address);

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });
    });

    describe('isRelativeLevelOperationActive', () => {
        it('should return true for active operations', () => {
            const callback = jest.fn();
            const address = '254/56/4';

            stateManager.setupRelativeLevelOperation(address, callback);

            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(true);
        });

        it('should return false for inactive operations', () => {
            const address = '254/56/4';

            expect(stateManager.isRelativeLevelOperationActive(address)).toBe(false);
        });
    });

    describe('getActiveOperationCount', () => {
        it('should return correct count of active operations', () => {
            expect(stateManager.getActiveOperationCount()).toBe(0);

            stateManager.setupRelativeLevelOperation('254/56/4', jest.fn());
            expect(stateManager.getActiveOperationCount()).toBe(1);

            stateManager.setupRelativeLevelOperation('254/56/5', jest.fn());
            expect(stateManager.getActiveOperationCount()).toBe(2);

            stateManager.cancelRelativeLevelOperation('254/56/4');
            expect(stateManager.getActiveOperationCount()).toBe(1);
        });
    });

    describe('clearAllOperations', () => {
        it('should clear all active operations', () => {
            stateManager.setupRelativeLevelOperation('254/56/4', jest.fn());
            stateManager.setupRelativeLevelOperation('254/56/5', jest.fn());
            
            expect(stateManager.getActiveOperationCount()).toBe(2);

            stateManager.clearAllOperations();

            expect(stateManager.getActiveOperationCount()).toBe(0);
            expect(mockLogger.info).toHaveBeenCalledWith('Cleared 2 active relative level operations');
        });

        it('should handle clearing when no operations are active', () => {
            stateManager.clearAllOperations();

            expect(stateManager.getActiveOperationCount()).toBe(0);
            expect(mockLogger.info).not.toHaveBeenCalled();
        });
    });

    describe('shutdown', () => {
        it('should clear operations and remove event listeners', () => {
            const clearSpy = jest.spyOn(stateManager, 'clearAllOperations');
            const removeAllListenersSpy = jest.spyOn(stateManager.getEventEmitter(), 'removeAllListeners');

            stateManager.setupRelativeLevelOperation('254/56/4', jest.fn());

            stateManager.shutdown();

            expect(clearSpy).toHaveBeenCalled();
            expect(removeAllListenersSpy).toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledWith('Device state manager shut down');
        });
    });

    describe('integration with CBusEvent', () => {
        it('should work with real CBusEvent objects for lighting events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            // Create real lighting event
            const lightingEvent = new CBusEvent('lighting on 254/56/4');
            
            stateManager.updateLevelFromEvent(lightingEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', CGATE_LEVEL_MAX);
        });

        it('should work with real CBusEvent objects for ramp events', () => {
            const emitSpy = jest.spyOn(stateManager.getEventEmitter(), 'emit');
            
            // Create real ramp event
            const rampEvent = new CBusEvent('lighting ramp 254/56/4 128');
            
            stateManager.updateLevelFromEvent(rampEvent);

            expect(emitSpy).toHaveBeenCalledWith(MQTT_TOPIC_SUFFIX_LEVEL, '254/56/4', 128);
        });
    });
});
