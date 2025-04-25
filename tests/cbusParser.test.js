/* eslint-disable no-unused-vars */
// tests/cbusParser.test.js

// Import necessary classes/functions from the main module
const { CBusEvent, CBusCommand } = require('../index.js');

// Mock console.warn for tests that expect warnings on invalid input
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { });

// Restore console.warn after all tests in this file
afterAll(() => {
    mockConsoleWarn.mockRestore();
});

describe('CBusEvent Parsing', () => {
    beforeEach(() => {
        // Clear mocks before each test in this suite if needed
        mockConsoleWarn.mockClear();
    });

    it('should correctly parse a lighting ON event', () => {
        const eventData = 'lighting on 254/56/10  # OID etc.';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('on');
        expect(cbusEvent.Host()).toBe('254');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('10');
        expect(cbusEvent.Level()).toBe('100');
    });

    it('should correctly parse a lighting OFF event', () => {
        const eventData = 'lighting off 10/38/123'; // No extra OID info
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('off');
        expect(cbusEvent.Host()).toBe('10');
        expect(cbusEvent.Group()).toBe('38');
        expect(cbusEvent.Device()).toBe('123');
        expect(cbusEvent.Level()).toBe('0');
    });

    it('should correctly parse a lighting RAMP event with level', () => {
        const eventData = 'lighting ramp 200/56/1 128'; // 128 = ~50%
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('ramp');
        expect(cbusEvent.Host()).toBe('200');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('1');
        expect(cbusEvent.Level()).toBe('50');
    });

    it('should correctly parse a lighting RAMP event to 0', () => {
        const eventData = 'lighting ramp 200/56/2 0';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('ramp');
        expect(cbusEvent.Host()).toBe('200');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('2');
        expect(cbusEvent.Level()).toBe('0');
    });

     it('should correctly parse a lighting RAMP event to 255', () => {
         const eventData = 'lighting ramp 200/56/3 255';
         const cbusEvent = new CBusEvent(eventData);
         expect(cbusEvent.isValid()).toBe(true);
         expect(cbusEvent.DeviceType()).toBe('lighting');
         expect(cbusEvent.Action()).toBe('ramp');
         expect(cbusEvent.Host()).toBe('200');
         expect(cbusEvent.Group()).toBe('56');
         expect(cbusEvent.Device()).toBe('3');
         expect(cbusEvent.Level()).toBe('100');
     });

    // Test for command port responses that mimic events
    it('should parse a 300- lighting ON event (partially)', () => {
        // Note: CBusEvent is designed for event port format.
        // It parses this command-port format, but DeviceType will be incorrect.
        const eventData = '300-lighting on 254/56/9';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true); // It *is* considered valid by the parser logic
        expect(cbusEvent.DeviceType()).toBe('300-lighting'); // Assert the actual parsed value
        expect(cbusEvent.Action()).toBe('on');
        expect(cbusEvent.Host()).toBe('254');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('9');
        expect(cbusEvent.Level()).toBe('100');
        // It parses without warning because all basic fields are found
        expect(mockConsoleWarn).not.toHaveBeenCalled();
    });

    it('should handle malformed event data gracefully', () => {
        const eventData = 'this is not valid';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false);
        expect(cbusEvent.DeviceType()).toBeNull();
        expect(cbusEvent.Action()).toBeNull();
        expect(cbusEvent.Host()).toBeNull();
        expect(cbusEvent.Group()).toBeNull();
        expect(cbusEvent.Device()).toBeNull();
        expect(cbusEvent.Level()).toBe('0'); // Default level
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle event data with missing parts gracefully', () => {
        const eventData = 'lighting on'; // Missing address
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });
});

describe('CBusCommand Parsing', () => {
    beforeEach(() => {
        mockConsoleWarn.mockClear();
    });

    it('should correctly parse a switch ON command', () => {
        const topic = 'cbus/write/254/56/10/switch';
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('10');
        expect(cbusCmd.CommandType()).toBe('switch');
        expect(cbusCmd.Message()).toBe('ON');
        expect(cbusCmd.Level()).toBe('100');
        expect(cbusCmd.RawLevel()).toBe(255);
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a switch OFF command', () => {
        const topic = 'cbus/write/10/38/123/switch';
        const message = 'OFF';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('10');
        expect(cbusCmd.Group()).toBe('38');
        expect(cbusCmd.Device()).toBe('123');
        expect(cbusCmd.CommandType()).toBe('switch');
        expect(cbusCmd.Message()).toBe('OFF');
        expect(cbusCmd.Level()).toBe('0');
        expect(cbusCmd.RawLevel()).toBe(0);
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a ramp level command', () => {
        const topic = 'cbus/write/200/56/1/ramp';
        const message = '50';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('200');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('1');
        expect(cbusCmd.CommandType()).toBe('ramp');
        expect(cbusCmd.Message()).toBe('50');
        expect(cbusCmd.Level()).toBe('50');
        expect(cbusCmd.RawLevel()).toBe(128); // ~50%
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a ramp level,time command', () => {
        const topic = 'cbus/write/200/56/2/ramp';
        const message = '75,4s';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('200');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('2');
        expect(cbusCmd.CommandType()).toBe('ramp');
        expect(cbusCmd.Message()).toBe('75,4s');
        expect(cbusCmd.Level()).toBe('75');
        expect(cbusCmd.RawLevel()).toBe(191); // ~75%
        expect(cbusCmd.RampTime()).toBe('4s');
    });

     it('should correctly parse a ramp ON command', () => {
         const topic = 'cbus/write/200/56/3/ramp';
         const message = 'ON';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.CommandType()).toBe('ramp');
         expect(cbusCmd.Message()).toBe('ON');
         expect(cbusCmd.Level()).toBe('100');
         expect(cbusCmd.RawLevel()).toBe(255);
         expect(cbusCmd.RampTime()).toBeNull();
     });

     it('should correctly parse a ramp OFF command', () => {
         const topic = 'cbus/write/200/56/4/ramp';
         const message = 'OFF';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.CommandType()).toBe('ramp');
         expect(cbusCmd.Message()).toBe('OFF');
         expect(cbusCmd.Level()).toBe('0');
         expect(cbusCmd.RawLevel()).toBe(0);
         expect(cbusCmd.RampTime()).toBeNull();
     });

      it('should correctly parse a ramp INCREASE command', () => {
          const topic = 'cbus/write/200/56/5/ramp';
          const message = 'INCREASE';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.CommandType()).toBe('ramp');
          expect(cbusCmd.Message()).toBe('INCREASE');
          expect(cbusCmd.Level()).toBeNull(); // Cannot determine level from INCREASE alone
          expect(cbusCmd.RawLevel()).toBeNull();
          expect(cbusCmd.RampTime()).toBeNull();
      });

       it('should correctly parse a ramp DECREASE command', () => {
           const topic = 'cbus/write/200/56/6/ramp';
           const message = 'DECREASE';
           const cbusCmd = new CBusCommand(topic, message);
           expect(cbusCmd.isValid()).toBe(true);
           expect(cbusCmd.CommandType()).toBe('ramp');
           expect(cbusCmd.Message()).toBe('DECREASE');
           expect(cbusCmd.Level()).toBeNull();
           expect(cbusCmd.RawLevel()).toBeNull();
           expect(cbusCmd.RampTime()).toBeNull();
       });

    it('should correctly parse a getall command', () => {
        const topic = 'cbus/write/254/56//getall'; // Note empty device ID
        const message = '';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe(''); // Device ID is empty
        expect(cbusCmd.CommandType()).toBe('getall');
        expect(cbusCmd.Message()).toBe('');
        expect(cbusCmd.Level()).toBeNull();
        expect(cbusCmd.RawLevel()).toBeNull();
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a gettree command', () => {
        const topic = 'cbus/write/254///gettree'; // Empty group and device
        const message = null; // Test null message
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('');
        expect(cbusCmd.Device()).toBe('');
        expect(cbusCmd.CommandType()).toBe('gettree');
        expect(cbusCmd.Message()).toBe('');
        expect(cbusCmd.Level()).toBeNull();
        expect(cbusCmd.RawLevel()).toBeNull();
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should handle malformed topic (too few parts)', () => {
        const topic = 'cbus/write/254/56/switch'; // Missing device
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(false);
        expect(cbusCmd.Host()).toBeNull();
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle malformed topic (wrong prefix)', () => {
        const topic = 'cbus/read/254/56/10/switch';
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

     it('should handle numeric ramp value greater than 100', () => {
         const topic = 'cbus/write/200/56/1/ramp';
         const message = '150';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.Level()).toBe('100'); // Should clamp to 100
         expect(cbusCmd.RawLevel()).toBe(255);
     });

      it('should handle numeric ramp value less than 0', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = '-50';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.Level()).toBe('0'); // Should clamp to 0
          expect(cbusCmd.RawLevel()).toBe(0);
      });

      it('should handle non-numeric ramp value gracefully', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = 'dim';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.Level()).toBeNull(); // Cannot determine level
          expect(cbusCmd.RawLevel()).toBeNull();
      });
}); 