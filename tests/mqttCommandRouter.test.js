const { EventEmitter } = require('events');
const MqttCommandRouter = require('../src/mqttCommandRouter');
const CBusCommand = require('../src/cbusCommand');

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
    });
});
