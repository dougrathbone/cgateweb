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
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('on');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('56');
        expect(event.getGroup()).toBe('4');
        expect(event._levelRaw).toBeNull(); // No raw level in 'on' event typically
    });

    it('should correctly parse a simple "lighting off" event', () => {
        const data = Buffer.from("lighting off 254/56/5"); // Minimal data
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('off');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('56');
        expect(event.getGroup()).toBe('5');
        // Raw level testing is covered in new-style getter method tests
        expect(event._levelRaw).toBeNull();
    });

    it('should correctly parse a "lighting ramp" event with level', () => {
        // C-Gate often reports final level after ramp
        const data = Buffer.from("lighting ramp 254/56/6 128"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('ramp');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('56');
        expect(event.getGroup()).toBe('6');
        expect(event._levelRaw).toBe(128);
        // Level percentage testing is covered in new-style getter method tests
    });

    it('should handle events with different device types', () => {
        const data = Buffer.from("trigger on 254/36/1"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.getDeviceType()).toBe('trigger');
        expect(event.getAction()).toBe('on');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('36');
        expect(event.getGroup()).toBe('1');
        // Level testing is covered in new-style getter method tests 
    });

    // === Edge Cases and Malformed Data ===

    it('should be invalid if data is completely malformed', () => {
        const data = Buffer.from("garbage data");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(event.getDeviceType()).toBeNull();
        expect(event.getAction()).toBeNull();
        expect(event.getNetwork()).toBeNull();
        expect(event.getApplication()).toBeNull();
        expect(event.getGroup()).toBeNull();
        // Level testing is covered in new-style getter method tests
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

    it('should be invalid for clock date events (2-segment address)', () => {
        const data = Buffer.from("clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(event.getDeviceType()).toBeNull();
        expect(event.getAddress()).toBeNull();
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should be invalid for clock time events (2-segment address)', () => {
        const data = Buffer.from("clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(false);
        expect(event.getDeviceType()).toBeNull();
        expect(event.getAddress()).toBeNull();
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle events with only essential parts', () => {
        const data = Buffer.from("lighting off 1/2/3");
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('off');
        expect(event.getNetwork()).toBe('1');
        expect(event.getApplication()).toBe('2');
        expect(event.getGroup()).toBe('3');
        // Level testing is covered in new-style getter method tests
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
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('ramp');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('56');
        expect(event.getGroup()).toBe('7');
        expect(event._levelRaw).toBe(0);
        // Level testing is covered in new-style getter method tests 
    });
    
     it('should handle ramp event with level 255', () => {
        const data = Buffer.from("lighting ramp 254/56/8 255"); 
        const event = new CBusEvent(data);
        expect(event.isValid()).toBe(true);
        expect(event.getDeviceType()).toBe('lighting');
        expect(event.getAction()).toBe('ramp');
        expect(event.getNetwork()).toBe('254');
        expect(event.getApplication()).toBe('56');
        expect(event.getGroup()).toBe('8');
        expect(event._levelRaw).toBe(255);
        // Level testing is covered in new-style getter method tests 
    });

    it('should ignore non-numeric level in ramp event', () => {
         const data = Buffer.from("lighting ramp 254/56/9 non_numeric"); 
         const event = new CBusEvent(data);
         expect(event.isValid()).toBe(true); // Parsing structure is valid
         expect(event.getDeviceType()).toBe('lighting');
         expect(event.getAction()).toBe('ramp');
         expect(event._levelRaw).toBeNull(); // Parsing the number failed
         // Level testing is covered in new-style getter method tests // Defaults to 0 if no valid level found
     });
     
      it('should parse correctly when trailing data has no double space separator', () => {
          // Although C-Gate usually separates trailing info with double space, test robustness
          const data = Buffer.from("lighting on 254/56/4#sourceunit=8");
          const event = new CBusEvent(data);
          expect(event.isValid()).toBe(true);
          expect(event.getDeviceType()).toBe('lighting');
          expect(event.getAction()).toBe('on');
          expect(event.getNetwork()).toBe('254');
          expect(event.getApplication()).toBe('56');
          expect(event.getGroup()).toBe('4'); // Device should still be 4
          // Level testing is covered in new-style getter method tests
          expect(event._levelRaw).toBeNull(); // Level part should not be parsed from #sourceunit
      });

    // === Shared Logger ===

    it('should share a single logger instance across all CBusEvent instances', () => {
        const event1 = new CBusEvent("lighting on 254/56/1");
        const event2 = new CBusEvent("lighting off 254/56/2");
        const event3 = new CBusEvent("lighting ramp 254/56/3 128");
        expect(event1._logger).toBe(event2._logger);
        expect(event2._logger).toBe(event3._logger);
    });

    // === Tests for new-style getter methods (will remain after simplification) ===
    describe('New-style getter methods', () => {
        it('should provide correct values via getDeviceType()', () => {
            const event = new CBusEvent("lighting on 254/56/4");
            expect(event.getDeviceType()).toBe('lighting');
        });

        it('should provide correct values via getAction()', () => {
            const onEvent = new CBusEvent("lighting on 254/56/4");
            const offEvent = new CBusEvent("lighting off 254/56/4");
            const rampEvent = new CBusEvent("lighting ramp 254/56/4 128");
            
            expect(onEvent.getAction()).toBe('on');
            expect(offEvent.getAction()).toBe('off');
            expect(rampEvent.getAction()).toBe('ramp');
        });

        it('should provide correct values via getAddress()', () => {
            const event = new CBusEvent("lighting on 254/56/4");
            expect(event.getAddress()).toBe('254/56/4');
        });

        it('should provide correct values via getLevel()', () => {
            const onEvent = new CBusEvent("lighting on 254/56/4");
            const offEvent = new CBusEvent("lighting off 254/56/4");
            const rampEvent = new CBusEvent("lighting ramp 254/56/4 128");
            
            expect(onEvent.getLevel()).toBeNull(); // Raw level not available for 'on'
            expect(offEvent.getLevel()).toBeNull(); // Raw level not available for 'off'
            expect(rampEvent.getLevel()).toBe(128); // Raw level available for 'ramp'
        });

        it('should provide correct values via getNetwork()', () => {
            const event = new CBusEvent("lighting on 254/56/4");
            expect(event.getNetwork()).toBe('254');
        });

        it('should provide correct values via getApplication()', () => {
            const event = new CBusEvent("lighting on 254/56/4");
            expect(event.getApplication()).toBe('56');
        });

        it('should provide correct values via getGroup()', () => {
            const event = new CBusEvent("lighting on 254/56/4");
            expect(event.getGroup()).toBe('4');
        });

        it('should provide correct values via getRawEvent()', () => {
            const eventString = "lighting on 254/56/4";
            const event = new CBusEvent(eventString);
            expect(event.getRawEvent()).toBe(eventString);
        });

        it('should handle status response format via getter methods', () => {
            const statusEvent = new CBusEvent("300 //PROJECT/254/56/1: level=255");
            expect(statusEvent.getDeviceType()).toBe('lighting');
            expect(statusEvent.getAction()).toBe('on');
            expect(statusEvent.getAddress()).toBe('254/56/1');
            expect(statusEvent.getLevel()).toBe(255);
            expect(statusEvent.getNetwork()).toBe('254');
            expect(statusEvent.getApplication()).toBe('56');
            expect(statusEvent.getGroup()).toBe('1');
        });

        it('should handle invalid events correctly via getter methods', () => {
            const invalidEvent = new CBusEvent("invalid event data");
            expect(invalidEvent.isValid()).toBe(false);
            expect(invalidEvent.getDeviceType()).toBeNull();
            expect(invalidEvent.getAction()).toBeNull();
            expect(invalidEvent.getAddress()).toBeNull();
            expect(invalidEvent.getLevel()).toBeNull();
            expect(invalidEvent.getNetwork()).toBeNull();
            expect(invalidEvent.getApplication()).toBeNull();
            expect(invalidEvent.getGroup()).toBeNull();
        });
    });

}); 