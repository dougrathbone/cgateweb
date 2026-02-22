const { EventEmitter } = require('events');
const MqttCommandRouter = require('../src/mqttCommandRouter');

describe('MqttCommandRouter', () => {
    let router;
    let mockQueue;
    let mockInternalEmitter;
    let queueSpy;

    beforeEach(() => {
        mockQueue = {
            add: jest.fn()
        };
        mockInternalEmitter = new EventEmitter();
        
        router = new MqttCommandRouter({
            cbusname: 'TestProject',
            ha_discovery_enabled: true,
            internalEventEmitter: mockInternalEmitter,
            cgateCommandQueue: mockQueue
        });

        queueSpy = jest.spyOn(mockQueue, 'add');
    });

    afterEach(() => {
        queueSpy.mockRestore();
    });

    describe('routeMessage()', () => {
        it('should handle manual HA discovery trigger', () => {
            const emitSpy = jest.spyOn(router, 'emit');
            
            router.routeMessage('cbus/write/bridge/announce', '');
            
            expect(emitSpy).toHaveBeenCalledWith('haDiscoveryTrigger');
        });

        it('should ignore manual trigger when HA discovery disabled', () => {
            router.haDiscoveryEnabled = false;
            const emitSpy = jest.spyOn(router, 'emit');
            
            router.routeMessage('cbus/write/bridge/announce', '');
            
            expect(emitSpy).not.toHaveBeenCalledWith('haDiscoveryTrigger');
        });

        it('should process valid write commands', () => {
            const processSpy = jest.spyOn(router, '_processCommand');
            
            router.routeMessage('cbus/write/254/56/4/switch', 'ON');
            
            expect(processSpy).toHaveBeenCalled();
        });

        it('should ignore invalid commands', () => {
            const processSpy = jest.spyOn(router, '_processCommand');
            
            router.routeMessage('invalid/topic', 'payload');
            
            expect(processSpy).not.toHaveBeenCalled();
        });
    });

    describe('Command Handlers', () => {
        describe('GetTree Commands', () => {
            it('should handle gettree commands', () => {
                const emitSpy = jest.spyOn(router, 'emit');
                
                router.routeMessage('cbus/write/254/0/0/gettree', '');
                
                expect(emitSpy).toHaveBeenCalledWith('treeRequest', '254');
                expect(queueSpy).toHaveBeenCalledWith('TREEXML 254\n');
            });
        });

        describe('GetAll Commands', () => {
            it('should handle getall commands', () => {
                router.routeMessage('cbus/write/254/56/0/getall', '');
                
                expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/* level\n');
            });
        });

        describe('Switch Commands', () => {
            it('should handle ON switch commands', () => {
                router.routeMessage('cbus/write/254/56/1/switch', 'ON');
                
                expect(queueSpy).toHaveBeenCalledWith('ON //TestProject/254/56/1\n');
            });

            it('should handle OFF switch commands', () => {
                router.routeMessage('cbus/write/254/56/1/switch', 'OFF');
                
                expect(queueSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/1\n');
            });

            it('should ignore invalid switch payloads', () => {
                router.routeMessage('cbus/write/254/56/1/switch', 'INVALID');
                
                expect(queueSpy).not.toHaveBeenCalled();
            });
        });

        describe('Ramp Commands', () => {
            it('should handle numeric level ramp', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', '75');
                
                expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 191\n');
            });

            it('should handle ramp with time specification', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', '50,5s');
                
                expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 128 5s\n');
            });

            it('should handle INCREASE command', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
                
                // Should first query current level
                expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/1 level\n');
                
                // Simulate level response
                mockInternalEmitter.emit('level', '254/56/1', 100);
                
                // Should then queue ramp to increased level
                expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 126\n');
            });

            it('should handle DECREASE command', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', 'DECREASE');
                
                // Should first query current level
                expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/1 level\n');
                
                // Simulate level response with higher level
                mockInternalEmitter.emit('level', '254/56/1', 200);
                
                // Should then queue ramp to decreased level (200 - 26 = 174)
                expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 174\n');
            });

            it('should handle ON in ramp context', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', 'ON');
                
                expect(queueSpy).toHaveBeenCalledWith('ON //TestProject/254/56/1\n');
            });

            it('should handle OFF in ramp context', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', 'OFF');
                
                expect(queueSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/1\n');
            });

            it('should reject ramp without device ID', () => {
                // This topic format is invalid - CBusCommand will reject it
                router.routeMessage('cbus/write/254/56//ramp', '75');
                
                expect(queueSpy).not.toHaveBeenCalled();
            });
        });
    });

    describe('Relative Level Handling', () => {
        it('should properly cap increase at maximum level', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            
            // Simulate high current level
            mockInternalEmitter.emit('level', '254/56/1', 250);
            
            // Should cap at 255
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 255\n');
        });

        it('should properly floor decrease at minimum level', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'DECREASE');
            
            // Simulate low current level
            mockInternalEmitter.emit('level', '254/56/1', 10);
            
            // Should floor at 0
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 0\n');
        });

        it('should still respond after non-matching level events arrive first', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            // Non-matching events for different addresses should not consume the listener
            mockInternalEmitter.emit('level', '254/56/2', 80);
            mockInternalEmitter.emit('level', '254/56/3', 200);

            // Only the GET query should have been queued so far
            expect(queueSpy).toHaveBeenCalledTimes(1);
            expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/1 level\n');

            // Now the matching event arrives
            mockInternalEmitter.emit('level', '254/56/1', 100);

            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 126\n');
        });

        it('should clean up listener after matching event', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            mockInternalEmitter.emit('level', '254/56/1', 100);
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 126\n');

            queueSpy.mockClear();

            // Further events for the same address should not trigger additional ramp commands
            mockInternalEmitter.emit('level', '254/56/1', 150);
            expect(queueSpy).not.toHaveBeenCalled();
        });

        it('should clean up listener after timeout if no matching response arrives', () => {
            jest.useFakeTimers();

            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            expect(mockInternalEmitter.listenerCount('level')).toBe(1);

            jest.advanceTimersByTime(5000);

            expect(mockInternalEmitter.listenerCount('level')).toBe(0);

            queueSpy.mockClear();

            // Events after timeout should not trigger ramp commands
            mockInternalEmitter.emit('level', '254/56/1', 100);
            expect(queueSpy).not.toHaveBeenCalled();

            jest.useRealTimers();
        });

        it('should clear timeout when matching response arrives before timeout', () => {
            jest.useFakeTimers();

            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            mockInternalEmitter.emit('level', '254/56/1', 100);
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 126\n');

            // Advancing past timeout should not cause errors or warnings
            jest.advanceTimersByTime(5000);
            expect(mockInternalEmitter.listenerCount('level')).toBe(0);

            jest.useRealTimers();
        });

        it('should not remove listener for non-matching events before timeout', () => {
            jest.useFakeTimers();

            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            // Non-matching events should leave listener intact
            mockInternalEmitter.emit('level', '254/56/2', 80);
            expect(mockInternalEmitter.listenerCount('level')).toBe(1);

            // Matching event should clean up
            mockInternalEmitter.emit('level', '254/56/1', 100);
            expect(mockInternalEmitter.listenerCount('level')).toBe(0);

            jest.useRealTimers();
        });
    });

    describe('Cover Position Commands', () => {
        it('should handle position command with percentage', () => {
            router.routeMessage('cbus/write/254/203/1/position', '50');
            
            // 50% of 255 = 128
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 128\n');
        });

        it('should handle position 0 (fully closed)', () => {
            router.routeMessage('cbus/write/254/203/1/position', '0');
            
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 0\n');
        });

        it('should handle position 100 (fully open)', () => {
            router.routeMessage('cbus/write/254/203/1/position', '100');
            
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 255\n');
        });

        it('should handle partial position', () => {
            router.routeMessage('cbus/write/254/203/1/position', '75');
            
            // 75% of 255 = 191
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 191\n');
        });

        it('should reject position command without device ID', () => {
            router.routeMessage('cbus/write/254/203//position', '50');
            
            expect(queueSpy).not.toHaveBeenCalled();
        });

        it('should not send command for non-numeric position value', () => {
            router.routeMessage('cbus/write/254/203/1/position', 'halfway');
            
            // Command is valid but level is null, so no RAMP command is sent
            expect(queueSpy).not.toHaveBeenCalled();
        });
    });

    describe('Cover Stop Commands', () => {
        it('should handle stop command', () => {
            router.routeMessage('cbus/write/254/203/1/stop', 'STOP');
            
            expect(queueSpy).toHaveBeenCalledWith('TERMINATERAMP //TestProject/254/203/1\n');
        });

        it('should handle stop command with empty payload', () => {
            router.routeMessage('cbus/write/254/203/1/stop', '');
            
            expect(queueSpy).toHaveBeenCalledWith('TERMINATERAMP //TestProject/254/203/1\n');
        });

        it('should reject stop command without device ID', () => {
            router.routeMessage('cbus/write/254/203//stop', 'STOP');
            
            expect(queueSpy).not.toHaveBeenCalled();
        });
    });
});
