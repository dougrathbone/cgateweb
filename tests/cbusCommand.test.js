// tests/cbusCommand.test.js

const CBusCommand = require('../src/cbusCommand');

describe('CBusCommand', () => {
    // Mock console.warn to avoid cluttering test output
    let mockConsoleWarn;
    beforeEach(() => {
        mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        mockConsoleWarn.mockRestore();
    });

    // === Valid Commands ===

    it('should parse a valid "switch ON" command', () => {
        const topic = 'cbus/write/254/56/7/switch';
        const message = Buffer.from('ON');
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.Host()).toBe('254');
        expect(command.Group()).toBe('56');
        expect(command.Device()).toBe('7');
        expect(command.CommandType()).toBe('switch');
        expect(command.Action()).toBe('switch'); // Action often defaults to CommandType
        expect(command.Message()).toBe('ON');
        expect(command.Level()).toBe('100');
        expect(command.RawLevel()).toBe(255);
        expect(command.RampTime()).toBeNull();
    });

    it('should parse a valid "switch OFF" command', () => {
        const topic = 'cbus/write/254/56/7/switch';
        const message = Buffer.from('OFF');
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('switch');
        expect(command.Message()).toBe('OFF');
        expect(command.Level()).toBe('0');
        expect(command.RawLevel()).toBe(0);
    });

    it('should parse a valid "ramp" command with percentage level', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('50'); // 50%
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('ramp');
        expect(command.Message()).toBe('50');
        expect(command.Level()).toBe('50');
        expect(command.RawLevel()).toBe(Math.round(50 * 255 / 100)); // 128
        expect(command.RampTime()).toBeNull();
    });

    it('should parse a valid "ramp" command with percentage level and time', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('75,2s'); // 75% over 2 seconds
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('ramp');
        expect(command.Message()).toBe('75,2s');
        expect(command.Level()).toBe('75');
        expect(command.RawLevel()).toBe(Math.round(75 * 255 / 100)); // 191
        expect(command.RampTime()).toBe('2s');
    });
    
    it('should parse a valid "ramp" command with ON payload', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('ON'); 
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('ramp');
        expect(command.Message()).toBe('ON');
        expect(command.Level()).toBe('100');
        expect(command.RawLevel()).toBe(255);
        expect(command.RampTime()).toBeNull();
    });
    
     it('should parse a valid "ramp" command with OFF payload', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('OFF'); 
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('ramp');
        expect(command.Message()).toBe('OFF');
        expect(command.Level()).toBe('0');
        expect(command.RawLevel()).toBe(0);
        expect(command.RampTime()).toBeNull();
    });

    it('should parse a valid "getall" command (no device ID)', () => {
        const topic = 'cbus/write/254/56//getall'; // Note the double slash
        const message = null; // No payload for getall
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.Host()).toBe('254');
        expect(command.Group()).toBe('56');
        expect(command.Device()).toBe(''); // Device should be empty
        expect(command.CommandType()).toBe('getall');
        expect(command.Message()).toBe('');
        expect(command.Level()).toBeNull();
        expect(command.RawLevel()).toBeNull();
        expect(command.RampTime()).toBeNull();
    });

    it('should parse a valid "gettree" command (no group/device ID)', () => {
        const topic = 'cbus/write/254///gettree'; // Triple slash
        const message = null;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.Host()).toBe('254');
        expect(command.Group()).toBe(''); // Group is empty
        expect(command.Device()).toBe(''); // Device is empty
        expect(command.CommandType()).toBe('gettree');
        expect(command.Message()).toBe('');
    });
    
     it('should handle null message gracefully', () => {
        const topic = 'cbus/write/254/56/7/switch';
        const message = null;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.Message()).toBe('');
        expect(command.Level()).toBeNull(); // Cannot determine level from null message
        expect(command.RawLevel()).toBeNull();
    });

    it('should handle undefined message gracefully', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = undefined;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.Message()).toBe('');
        expect(command.Level()).toBeNull();
        expect(command.RawLevel()).toBeNull();
        expect(command.RampTime()).toBeNull();
    });

    // === Invalid Commands / Malformed Topics ===

    it('should be invalid if topic prefix is wrong', () => {
        const topic = 'cbus/read/254/56/7/switch'; // read instead of write
        const message = Buffer.from('ON');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should be invalid if topic has too few parts', () => {
        const topic = 'cbus/write/254/56/switch'; // Missing device ID part
        const message = Buffer.from('ON');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should be invalid if topic is empty', () => {
        const topic = ''; 
        const message = Buffer.from('ON');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should be invalid if topic is null', () => {
        const topic = null; 
        const message = Buffer.from('ON');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    // === Level/Ramp Calculation Edge Cases ===

    it('should clamp ramp percentage level > 100', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('150'); // 150%
        const command = new CBusCommand(topic, message);
        expect(command.Level()).toBe('100');
        expect(command.RawLevel()).toBe(255);
    });

    it('should clamp ramp percentage level < 0', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('-50'); // -50%
        const command = new CBusCommand(topic, message);
        expect(command.Level()).toBe('0');
        expect(command.RawLevel()).toBe(0);
    });

    it('should return null for levels if message is non-numeric for ramp/switch', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('fifty');
        const command = new CBusCommand(topic, message);
        expect(command.Level()).toBeNull();
        expect(command.RawLevel()).toBeNull();
    });
    
    it('should return null for levels if message is numeric but command type is not ramp/switch', () => {
        // Example: A hypothetical command that takes a number but isn't ramp/switch
        const topic = 'cbus/write/254/56/8/setvalue'; 
        const message = Buffer.from('42');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(true);
        expect(command.CommandType()).toBe('setvalue');
        expect(command.Level()).toBeNull(); // Level calculation only applies to ramp/switch
        expect(command.RawLevel()).toBeNull(); // RawLevel calculation only applies to ramp
    });

     it('should parse ramp time correctly with spaces', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from(' 75 , 3m '); // Spaces around comma and time
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(true);
        expect(command.Level()).toBe('75');
        expect(command.RawLevel()).toBe(Math.round(75 * 255 / 100));
        expect(command.RampTime()).toBe('3m');
    });
    
     it('should return null ramp time if only level specified', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('50'); 
        const command = new CBusCommand(topic, message);
        expect(command.RampTime()).toBeNull();
    });

}); 