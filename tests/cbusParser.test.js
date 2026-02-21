 
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
        expect(cbusEvent.getDeviceType()).toBe('lighting');
        expect(cbusEvent.getAction()).toBe('on');
        expect(cbusEvent.getNetwork()).toBe('254');
        expect(cbusEvent.getApplication()).toBe('56');
        expect(cbusEvent.getGroup()).toBe('10');
        expect(cbusEvent.getLevel()).toBeNull(); // ON events don't have raw level data
    });

    it('should correctly parse a lighting OFF event', () => {
        const eventData = 'lighting off 10/38/123'; // No extra OID info
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.getDeviceType()).toBe('lighting');
        expect(cbusEvent.getAction()).toBe('off');
        expect(cbusEvent.getNetwork()).toBe('10');
        expect(cbusEvent.getApplication()).toBe('38');
        expect(cbusEvent.getGroup()).toBe('123');
        expect(cbusEvent.getLevel()).toBeNull(); // OFF events don't have raw level data
    });

    it('should correctly parse a lighting RAMP event with level', () => {
        const eventData = 'lighting ramp 200/56/1 128'; // 128 = ~50%
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.getDeviceType()).toBe('lighting');
        expect(cbusEvent.getAction()).toBe('ramp');
        expect(cbusEvent.getNetwork()).toBe('200');
        expect(cbusEvent.getApplication()).toBe('56');
        expect(cbusEvent.getGroup()).toBe('1');
        expect(cbusEvent.getLevel()).toBe(128); // Raw level value
    });

    it('should correctly parse a lighting RAMP event to 0', () => {
        const eventData = 'lighting ramp 200/56/2 0';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.getDeviceType()).toBe('lighting');
        expect(cbusEvent.getAction()).toBe('ramp');
        expect(cbusEvent.getNetwork()).toBe('200');
        expect(cbusEvent.getApplication()).toBe('56');
        expect(cbusEvent.getGroup()).toBe('2');
        expect(cbusEvent.getLevel()).toBe(0); // Raw level value
    });

     it('should correctly parse a lighting RAMP event to 255', () => {
         const eventData = 'lighting ramp 200/56/3 255';
         const cbusEvent = new CBusEvent(eventData);
         expect(cbusEvent.isValid()).toBe(true);
         expect(cbusEvent.getDeviceType()).toBe('lighting');
         expect(cbusEvent.getAction()).toBe('ramp');
         expect(cbusEvent.getNetwork()).toBe('200');
         expect(cbusEvent.getApplication()).toBe('56');
         expect(cbusEvent.getGroup()).toBe('3');
         expect(cbusEvent.getLevel()).toBe(255); // Raw level value
     });

    // Test for command port responses that mimic events
    it('should NOT parse a 300- prefixed line as a valid CBusEvent', () => {
        // CBusEvent is designed for event port format, not command port responses like 300-
        const eventData = '300-lighting on 254/56/9';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false); 
        // Expect warning because the regex match will fail
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle malformed event data gracefully', () => {
        const eventData = 'this is not valid';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false);
        expect(cbusEvent.getDeviceType()).toBeNull();
        expect(cbusEvent.getAction()).toBeNull();
        expect(cbusEvent.getNetwork()).toBeNull();
        expect(cbusEvent.getApplication()).toBeNull();
        expect(cbusEvent.getGroup()).toBeNull();
        expect(cbusEvent.getLevel()).toBeNull(); // No level for invalid events
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
        expect(cbusCmd.getNetwork()).toBe('254');
        expect(cbusCmd.getApplication()).toBe('56');
        expect(cbusCmd.getGroup()).toBe('10');
        expect(cbusCmd.getCommandType()).toBe('switch');
        expect(cbusCmd.getPayload()).toBe('ON');
        expect(cbusCmd.getLevel()).toBe(255);
        expect(cbusCmd.getLevel()).toBe(255);
        expect(cbusCmd.getRampTime()).toBeNull();
    });

    it('should correctly parse a switch OFF command', () => {
        const topic = 'cbus/write/10/38/123/switch';
        const message = 'OFF';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('10');
        expect(cbusCmd.getApplication()).toBe('38');
        expect(cbusCmd.getGroup()).toBe('123');
        expect(cbusCmd.getCommandType()).toBe('switch');
        expect(cbusCmd.getPayload()).toBe('OFF');
        expect(cbusCmd.getLevel()).toBe(0);
        expect(cbusCmd.getLevel()).toBe(0);
        expect(cbusCmd.getRampTime()).toBeNull();
    });

    it('should correctly parse a ramp level command', () => {
        const topic = 'cbus/write/200/56/1/ramp';
        const message = '50';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('200');
        expect(cbusCmd.getApplication()).toBe('56');
        expect(cbusCmd.getGroup()).toBe('1');
        expect(cbusCmd.getCommandType()).toBe('ramp');
        expect(cbusCmd.getPayload()).toBe('50');
        expect(cbusCmd.getLevel()).toBe(128);
        expect(cbusCmd.getLevel()).toBe(128); // ~50%
        expect(cbusCmd.getRampTime()).toBeNull();
    });

    it('should correctly parse a ramp level,time command', () => {
        const topic = 'cbus/write/200/56/2/ramp';
        const message = '75,4s';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('200');
        expect(cbusCmd.getApplication()).toBe('56');
        expect(cbusCmd.getGroup()).toBe('2');
        expect(cbusCmd.getCommandType()).toBe('ramp');
        expect(cbusCmd.getPayload()).toBe('75,4s');
        expect(cbusCmd.getLevel()).toBe(191);
        expect(cbusCmd.getLevel()).toBe(191); // ~75%
        expect(cbusCmd.getRampTime()).toBe('4s');
    });

     it('should correctly parse a ramp ON command', () => {
         const topic = 'cbus/write/200/56/3/ramp';
         const message = 'ON';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.getCommandType()).toBe('ramp');
         expect(cbusCmd.getPayload()).toBe('ON');
         expect(cbusCmd.getLevel()).toBe(255);
         expect(cbusCmd.getLevel()).toBe(255);
         expect(cbusCmd.getRampTime()).toBeNull();
     });

     it('should correctly parse a ramp OFF command', () => {
         const topic = 'cbus/write/200/56/4/ramp';
         const message = 'OFF';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.getCommandType()).toBe('ramp');
         expect(cbusCmd.getPayload()).toBe('OFF');
         expect(cbusCmd.getLevel()).toBe(0);
         expect(cbusCmd.getLevel()).toBe(0);
         expect(cbusCmd.getRampTime()).toBeNull();
     });

      it('should correctly parse a ramp INCREASE command', () => {
          const topic = 'cbus/write/200/56/5/ramp';
          const message = 'INCREASE';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.getCommandType()).toBe('ramp');
          expect(cbusCmd.getPayload()).toBe('INCREASE');
          expect(cbusCmd.getLevel()).toBe('INCREASE'); // Raw level is 'INCREASE' string
          expect(cbusCmd.getRampTime()).toBeNull();
      });

       it('should correctly parse a ramp DECREASE command', () => {
           const topic = 'cbus/write/200/56/6/ramp';
           const message = 'DECREASE';
           const cbusCmd = new CBusCommand(topic, message);
           expect(cbusCmd.isValid()).toBe(true);
           expect(cbusCmd.getCommandType()).toBe('ramp');
           expect(cbusCmd.getPayload()).toBe('DECREASE');
           expect(cbusCmd.getLevel()).toBe('DECREASE'); // Raw level is 'DECREASE' string
           expect(cbusCmd.getRampTime()).toBeNull();
       });

    it('should correctly parse a getall command', () => {
        const topic = 'cbus/write/254/56//getall'; // Note empty device ID
        const message = '';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('254');
        expect(cbusCmd.getApplication()).toBe('56');
        expect(cbusCmd.getGroup()).toBe(''); // Device ID is empty
        expect(cbusCmd.getCommandType()).toBe('getall');
        expect(cbusCmd.getPayload()).toBe('');
        expect(cbusCmd.getLevel()).toBeNull();
        expect(cbusCmd.getLevel()).toBeNull();
        expect(cbusCmd.getRampTime()).toBeNull();
    });

    it('should correctly parse a gettree command', () => {
        const topic = 'cbus/write/254///gettree'; // Empty group and device
        const message = null; // Test null message
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('254');
        expect(cbusCmd.getApplication()).toBe('');
        expect(cbusCmd.getGroup()).toBe('');
        expect(cbusCmd.getCommandType()).toBe('gettree');
        expect(cbusCmd.getPayload()).toBe('');
        expect(cbusCmd.getLevel()).toBeNull();
        expect(cbusCmd.getLevel()).toBeNull();
        expect(cbusCmd.getRampTime()).toBeNull();
    });

    it('should handle malformed topic (too few parts)', () => {
        const topic = 'cbus/write/254/56/switch'; // Missing device
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(false);
        expect(cbusCmd.getNetwork()).toBeNull();
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
         expect(cbusCmd.getLevel()).toBe(255); // Should clamp to 100%, raw = 255
     });

      it('should handle numeric ramp value less than 0', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = '-50';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.getLevel()).toBe(0); // Should clamp to 0%, raw = 0
      });

      it('should handle non-numeric ramp value gracefully', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = 'dim';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(false);
          expect(cbusCmd.getLevel()).toBeNull();
      });
}); 