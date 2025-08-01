// tests/cbusEvent.test.js

const CBusEvent = require('../src/cbusEvent');

describe('CBusEvent', () => {
    // Mock console.warn to avoid cluttering test output
    let mockConsoleWarn;
    beforeEach(() => {
        mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        mockConsoleWarn.mockRestore();
    });

    // === Basic Valid Events ===

    it('should correctly parse a simple "lighting on" event', () => {
        const data = Buffer.from("lighting on 254/56/4  #sourceunit=8 OID=... sessionId=...");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('on');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('56');
        expect(event.Device()).toBe('4');
        expect(event.Level()).toBe('100'); // 'on' translates to 100%
        expect(event._levelRaw).toBeNull(); // No raw level in 'on' event typically
    });

    it('should correctly parse a simple "lighting off" event', () => {
        const data = Buffer.from("lighting off 254/56/5"); // Minimal data
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('off');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('56');
        expect(event.Device()).toBe('5');
        expect(event.Level()).toBe('0'); // 'off' translates to 0%
        expect(event._levelRaw).toBeNull();
    });

    it('should correctly parse a "lighting ramp" event with level', () => {
        // C-Gate often reports final level after ramp
        const data = Buffer.from("lighting ramp 254/56/6 128"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('ramp');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('56');
        expect(event.Device()).toBe('6');
        expect(event._levelRaw).toBe(128);
        expect(event.Level()).toBe(Math.round(128 * 100 / 255).toString()); // Calculate expected percentage
    });

    it('should handle events with different device types', () => {
        const data = Buffer.from("trigger on 254/36/1"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('trigger');
        expect(event.Action()).toBe('on');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('36');
        expect(event.Device()).toBe('1');
        expect(event.Level()).toBe('100'); 
    });

    // === Edge Cases and Malformed Data ===

    it('should be invalid if data is completely malformed', () => {
        const data = Buffer.from("garbage data");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(event.DeviceType()).toBeNull();
        expect(event.Action()).toBeNull();
        expect(event.Host()).toBeNull();
        expect(event.Group()).toBeNull();
        expect(event.Device()).toBeNull();
        expect(event.Level()).toBe('0'); // Should default to 0
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should be invalid if address part is missing', () => {
        const data = Buffer.from("lighting on");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });
    
    it('should be invalid if address part is incomplete', () => {
        const data = Buffer.from("lighting on 254/56");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
         expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle events with only essential parts', () => {
        const data = Buffer.from("lighting off 1/2/3");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('off');
        expect(event.Host()).toBe('1');
        expect(event.Group()).toBe('2');
        expect(event.Device()).toBe('3');
        expect(event.Level()).toBe('0');
    });

    it('should handle empty input buffer', () => {
        const data = Buffer.from("");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

     it('should handle input with only spaces', () => {
        const data = Buffer.from("   ");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle ramp event with level 0', () => {
        const data = Buffer.from("lighting ramp 254/56/7 0"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('ramp');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('56');
        expect(event.Device()).toBe('7');
        expect(event._levelRaw).toBe(0);
        expect(event.Level()).toBe('0'); 
    });
    
     it('should handle ramp event with level 255', () => {
        const data = Buffer.from("lighting ramp 254/56/8 255"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.DeviceType()).toBe('lighting');
        expect(event.Action()).toBe('ramp');
        expect(event.Host()).toBe('254');
        expect(event.Group()).toBe('56');
        expect(event.Device()).toBe('8');
        expect(event._levelRaw).toBe(255);
        expect(event.Level()).toBe('100'); 
    });

    it('should ignore non-numeric level in ramp event for Level() calculation', () => {
         const data = Buffer.from("lighting ramp 254/56/9 non_numeric"); 
         const event = new CBusEvent(data);
         expect(event.isValid()).toBe(true); // Parsing structure is valid
         expect(event.DeviceType()).toBe('lighting');
         expect(event.Action()).toBe('ramp');
         expect(event._levelRaw).toBeNull(); // Parsing the number failed
         expect(event.Level()).toBe('0'); // Defaults to 0 if no valid level found
     });
     
      it('should parse correctly when trailing data has no double space separator', () => {
          // Although C-Gate usually separates trailing info with double space, test robustness
          const data = Buffer.from("lighting on 254/56/4#sourceunit=8");
          const event = new CBusEvent(data);
          expect(event.isValid()).toBe(true);
          expect(event.DeviceType()).toBe('lighting');
          expect(event.Action()).toBe('on');
          expect(event.Host()).toBe('254');
          expect(event.Group()).toBe('56');
          expect(event.Device()).toBe('4'); // Device should still be 4
          expect(event.Level()).toBe('100');
          expect(event._levelRaw).toBeNull(); // Level part should not be parsed from #sourceunit
      });

}); 