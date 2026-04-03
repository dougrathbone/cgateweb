 
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

    it.each([
        ['on',   'lighting on 254/56/10  # OID etc.', '254', '56', '10',  null],
        ['off',  'lighting off 10/38/123',             '10',  '38', '123', null],
        ['ramp', 'lighting ramp 200/56/1 128',         '200', '56', '1',   128],
        ['ramp', 'lighting ramp 200/56/2 0',           '200', '56', '2',   0],
        ['ramp', 'lighting ramp 200/56/3 255',         '200', '56', '3',   255],
    ])('should correctly parse a lighting %s event', (action, eventData, net, app, group, level) => {
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.getDeviceType()).toBe('lighting');
        expect(cbusEvent.getAction()).toBe(action);
        expect(cbusEvent.getNetwork()).toBe(net);
        expect(cbusEvent.getApplication()).toBe(app);
        expect(cbusEvent.getGroup()).toBe(group);
        expect(cbusEvent.getLevel()).toBe(level);
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

    it.each([
        ['switch', '254/56/10', 'ON',       'switch', 'ON',       255,        null,  null],
        ['switch', '10/38/123', 'OFF',      'switch', 'OFF',      0,          null,  null],
        ['ramp',   '200/56/1',  '50',       'ramp',   '50',       128,        null,  null],
        ['ramp',   '200/56/2',  '75,4s',    'ramp',   '75,4s',    191,        '4s',  null],
        ['ramp',   '200/56/3',  'ON',       'ramp',   'ON',       255,        null,  null],
        ['ramp',   '200/56/4',  'OFF',      'ramp',   'OFF',      0,          null,  null],
        ['ramp',   '200/56/5',  'INCREASE', 'ramp',   'INCREASE', 'INCREASE', null,  null],
        ['ramp',   '200/56/6',  'DECREASE', 'ramp',   'DECREASE', 'DECREASE', null,  null],
    ])('should correctly parse a %s %s command', (type, addr, msg, cmdType, payload, level, rampTime) => {
        const cbusCmd = new CBusCommand(`cbus/write/${addr}/${type}`, msg);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getCommandType()).toBe(cmdType);
        expect(cbusCmd.getPayload()).toBe(payload);
        expect(cbusCmd.getLevel()).toBe(level);
        expect(cbusCmd.getRampTime()).toBe(rampTime);
    });

    it('should correctly parse a getall command', () => {
        const cbusCmd = new CBusCommand('cbus/write/254/56//getall', '');
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('254');
        expect(cbusCmd.getApplication()).toBe('56');
        expect(cbusCmd.getGroup()).toBe('');
        expect(cbusCmd.getCommandType()).toBe('getall');
        expect(cbusCmd.getLevel()).toBeNull();
    });

    it('should correctly parse a gettree command', () => {
        const cbusCmd = new CBusCommand('cbus/write/254///gettree', null);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.getNetwork()).toBe('254');
        expect(cbusCmd.getCommandType()).toBe('gettree');
        expect(cbusCmd.getLevel()).toBeNull();
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