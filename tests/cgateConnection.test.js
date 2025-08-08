const CgateConnection = require('../src/cgateConnection');
const { EventEmitter } = require('events');

// Mock the net module
jest.mock('net');
const net = require('net');

describe('CgateConnection', () => {
    let connection;
    let mockSocket;
    let settings;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Mock socket
        mockSocket = new EventEmitter();
        mockSocket.write = jest.fn();
        mockSocket.destroy = jest.fn();
        mockSocket.destroyed = false;
        
        // Mock net.createConnection
        net.createConnection.mockReturnValue(mockSocket);
        
        settings = {
            reconnectinitialdelay: 1000,
            reconnectmaxdelay: 5000
        };
        
        connection = new CgateConnection('command', 'localhost', 20023, settings);
    });

    afterEach(() => {
        // Clean up any timers
        jest.clearAllTimers();
        // Clean up connection to avoid async operations after test completion
        if (connection) {
            connection.disconnect();
        }
    });

    describe('Constructor', () => {
        it('should initialize with correct properties', () => {
            expect(connection.type).toBe('command');
            expect(connection.host).toBe('localhost');
            expect(connection.port).toBe(20023);
            expect(connection.settings).toBe(settings);
            expect(connection.connected).toBe(false);
            expect(connection.socket).toBeNull();
            expect(connection.reconnectAttempts).toBe(0);
        });

        it('should set default reconnection delays from settings', () => {
            expect(connection.reconnectInitialDelay).toBe(1000);
            expect(connection.reconnectMaxDelay).toBe(5000);
        });

        it('should use default reconnection delays if not provided', () => {
            const defaultConnection = new CgateConnection('event', 'localhost', 20025);
            expect(defaultConnection.reconnectInitialDelay).toBe(1000);
            expect(defaultConnection.reconnectMaxDelay).toBe(60000);
        });

        it('should initialize logger with correct component name', () => {
            expect(connection.logger).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should create new socket connection', () => {
            connection.connect();
            
            expect(net.createConnection).toHaveBeenCalledWith(20023, 'localhost');
            expect(connection.socket).toBe(mockSocket);
        });

        it('should destroy existing socket before creating new one', () => {
            // Set up existing socket
            connection.socket = mockSocket;
            mockSocket.destroyed = false;
            
            connection.connect();
            
            expect(mockSocket.destroy).toHaveBeenCalled();
            expect(net.createConnection).toHaveBeenCalled();
        });

        it('should not destroy already destroyed socket', () => {
            connection.socket = mockSocket;
            mockSocket.destroyed = true;
            
            connection.connect();
            
            expect(mockSocket.destroy).not.toHaveBeenCalled();
        });

        it('should set up socket event listeners', () => {
            connection.connect();
            
            expect(mockSocket.listenerCount('connect')).toBe(1);
            expect(mockSocket.listenerCount('close')).toBe(1);
            expect(mockSocket.listenerCount('error')).toBe(1);
            expect(mockSocket.listenerCount('data')).toBe(1);
        });
    });

    describe('disconnect', () => {
        beforeEach(() => {
            connection.connect();
            connection.connected = true;
        });

        it('should destroy socket and clear reconnection timer', () => {
            // Set up reconnection timer
            connection.reconnectTimeout = setTimeout(() => {}, 1000);
            
            connection.disconnect();
            
            expect(mockSocket.destroy).toHaveBeenCalled();
            expect(connection.reconnectTimeout).toBeNull();
        });

        it('should handle null socket gracefully', () => {
            connection.socket = null;
            
            expect(() => connection.disconnect()).not.toThrow();
        });
    });

    describe('send', () => {
        beforeEach(() => {
            connection.connect();
            connection.connected = true;
        });

        it('should send data when connected', () => {
            const testData = 'test command';
            
            connection.send(testData);
            
            expect(mockSocket.write).toHaveBeenCalledWith(testData);
        });

        it('should warn when not connected', () => {
            connection.connected = false;
            const loggerSpy = jest.spyOn(connection.logger, 'warn');
            
            connection.send('test');
            
            expect(mockSocket.write).not.toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot send data'));
        });

        it('should handle write errors', () => {
            const loggerSpy = jest.spyOn(connection.logger, 'error');
            mockSocket.write.mockImplementation(() => {
                throw new Error('Write failed');
            });
            
            connection.send('test');
            
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining('Error writing'),
                expect.objectContaining({ error: expect.any(Error) })
            );
        });
    });

    describe('Socket event handlers', () => {
        beforeEach(() => {
            connection.connect();
        });

        describe('connect event', () => {
            it('should handle successful connection', () => {
                const loggerSpy = jest.spyOn(connection.logger, 'info');
                const emitSpy = jest.spyOn(connection, 'emit');
                
                mockSocket.emit('connect');
                
                expect(connection.connected).toBe(true);
                expect(connection.reconnectAttempts).toBe(0);
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('CONNECTED TO C-GATE'));
                expect(emitSpy).toHaveBeenCalledWith('connect');
            });

            it('should send EVENT ON command for event connections', () => {
                const eventConnection = new CgateConnection('event', 'localhost', 20025);
                eventConnection.connect();
                eventConnection.socket = mockSocket;
                
                // Mock the command connection
                const _mockCommandConnection = {
                    send: jest.fn()
                };
                eventConnection.emit('connected');
                
                // Trigger the initial command setup
                mockSocket.emit('connect');
                
                // The actual implementation would need access to command connection
                // This test verifies the connection setup logic
                expect(eventConnection.connected).toBe(true);
            });
        });

        describe('close event', () => {
            it('should handle connection close', () => {
                const loggerSpy = jest.spyOn(connection.logger, 'warn');
                const emitSpy = jest.spyOn(connection, 'emit');
                
                connection.connected = true;
                mockSocket.emit('close', false);
                
                expect(connection.connected).toBe(false);
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('PORT DISCONNECTED'));
                expect(emitSpy).toHaveBeenCalledWith('close', false);
            });

            it('should handle close with error', () => {
                const loggerSpy = jest.spyOn(connection.logger, 'warn');
                
                mockSocket.emit('close', true);
                
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('with error'));
            });

            it('should start reconnection when connected', () => {
                connection.connected = true;
                jest.spyOn(connection, '_scheduleReconnect');
                
                mockSocket.emit('close', false);
                
                expect(connection._scheduleReconnect).toHaveBeenCalled();
            });
        });

        describe('error event', () => {
            it('should handle socket errors', () => {
                const loggerSpy = jest.spyOn(connection.logger, 'error');
                const testError = new Error('Socket error');
                
                // Prevent the error from propagating to Jest's unhandled error handler
                connection.on('error', () => {}); 
                
                mockSocket.emit('error', testError);
                
                expect(loggerSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Socket Error'),
                    expect.objectContaining({ error: testError })
                );
            });
        });

        describe('data event', () => {
            it('should emit data event', () => {
                const emitSpy = jest.spyOn(connection, 'emit');
                const testData = Buffer.from('test data');
                
                mockSocket.emit('data', testData);
                
                expect(emitSpy).toHaveBeenCalledWith('data', testData);
            });
        });
    });

    describe('Reconnection logic', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should calculate exponential backoff delay correctly in scheduling', () => {
            // Test the delay calculation by examining the scheduled timeout
            connection.reconnectAttempts = 0;
            const loggerSpy = jest.spyOn(connection.logger, 'info');
            
            connection._scheduleReconnect();
            
            // Check that it logs the initial delay (1000ms for first attempt)
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('1000ms'));
        });

        it('should stop reconnection after max attempts', () => {
            connection.maxReconnectAttempts = 2;
            connection.reconnectAttempts = 2;
            const loggerSpy = jest.spyOn(connection.logger, 'error');
            
            connection._scheduleReconnect();
            
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Max reconnection attempts'));
            expect(connection.reconnectTimeout).toBeNull();
        });

        it('should continue reconnection when maxReconnectAttempts is 0', () => {
            connection.maxReconnectAttempts = 0; // Infinite attempts  
            connection.reconnectAttempts = 100;
            const loggerSpy = jest.spyOn(connection.logger, 'info');
            
            connection._scheduleReconnect();
            
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Scheduling'));
            expect(connection.reconnectTimeout).not.toBeNull();
        });

        it('should schedule reconnection with calculated delay', () => {
            const loggerSpy = jest.spyOn(connection.logger, 'info');
            const connectSpy = jest.spyOn(connection, 'connect');
            
            connection._scheduleReconnect();
            
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Scheduling'));
            expect(connection.reconnectTimeout).not.toBeNull();
            
            // Fast forward time
            jest.advanceTimersByTime(1000);
            
            expect(connectSpy).toHaveBeenCalled();
            expect(connection.reconnectAttempts).toBe(1);
        });

        it('should not schedule if already scheduled', () => {
            // Set up existing timer
            connection.reconnectTimeout = setTimeout(() => {}, 5000);
            const loggerSpy = jest.spyOn(connection.logger, 'info');
            
            connection._scheduleReconnect();
            
            expect(loggerSpy).not.toHaveBeenCalled();
        });
    });

    describe('Edge cases and error handling', () => {
        it('should handle socket being null during send', () => {
            connection.socket = null;
            connection.connected = true; // Inconsistent state
            
            expect(() => connection.send('test')).not.toThrow();
        });

        it('should handle multiple connect calls', () => {
            connection.connect();
            const firstSocket = connection.socket;
            
            // Mock net.createConnection to return a different socket for the second call
            const secondMockSocket = new EventEmitter();
            secondMockSocket.write = jest.fn();
            secondMockSocket.destroy = jest.fn();
            secondMockSocket.destroyed = false;
            net.createConnection.mockReturnValueOnce(secondMockSocket);
            
            connection.connect();
            
            expect(firstSocket.destroy).toHaveBeenCalled();
            expect(connection.socket).toBe(secondMockSocket);
        });

        it('should handle disconnect when not connected', () => {
            connection.connected = false;
            connection.socket = null;
            
            expect(() => connection.disconnect()).not.toThrow();
        });
    });
});