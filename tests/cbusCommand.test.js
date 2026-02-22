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
        expect(command.getNetwork()).toBe('254');
        expect(command.getApplication()).toBe('56');
        expect(command.getGroup()).toBe('7');
        expect(command.getCommandType()).toBe('switch');
        expect(command.getCommandType()).toBe('switch'); // Action often defaults to CommandType
        expect(command.getPayload()).toBe('ON');
        expect(command.getLevel()).toBe(255);
        expect(command.getLevel()).toBe(255);
        expect(command.getRampTime()).toBeNull();
    });

    it('should parse a valid "switch OFF" command', () => {
        const topic = 'cbus/write/254/56/7/switch';
        const message = Buffer.from('OFF');
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('switch');
        expect(command.getPayload()).toBe('OFF');
        expect(command.getLevel()).toBe(0);
        expect(command.getLevel()).toBe(0);
    });

    it('should parse a valid "ramp" command with percentage level', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('50'); // 50%
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('ramp');
        expect(command.getPayload()).toBe('50');
        expect(command.getLevel()).toBe(Math.round(50 * 255 / 100));
        expect(command.getLevel()).toBe(Math.round(50 * 255 / 100)); // 128
        expect(command.getRampTime()).toBeNull();
    });

    it('should parse a valid "ramp" command with percentage level and time', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('75,2s'); // 75% over 2 seconds
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('ramp');
        expect(command.getPayload()).toBe('75,2s');
        expect(command.getLevel()).toBe(Math.round(75 * 255 / 100));
        expect(command.getLevel()).toBe(Math.round(75 * 255 / 100)); // 191
        expect(command.getRampTime()).toBe('2s');
    });
    
    it('should parse a valid "ramp" command with ON payload', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('ON'); 
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('ramp');
        expect(command.getPayload()).toBe('ON');
        expect(command.getLevel()).toBe(255);
        expect(command.getLevel()).toBe(255);
        expect(command.getRampTime()).toBeNull();
    });
    
     it('should parse a valid "ramp" command with OFF payload', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('OFF'); 
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('ramp');
        expect(command.getPayload()).toBe('OFF');
        expect(command.getLevel()).toBe(0);
        expect(command.getLevel()).toBe(0);
        expect(command.getRampTime()).toBeNull();
    });

    it('should parse a valid "getall" command (no device ID)', () => {
        const topic = 'cbus/write/254/56//getall'; // Note the double slash
        const message = null; // No payload for getall
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getNetwork()).toBe('254');
        expect(command.getApplication()).toBe('56');
        expect(command.getGroup()).toBe(''); // Device should be empty
        expect(command.getCommandType()).toBe('getall');
        expect(command.getPayload()).toBe('');
        expect(command.getLevel()).toBeNull();
        expect(command.getLevel()).toBeNull();
        expect(command.getRampTime()).toBeNull();
    });

    it('should parse a valid "gettree" command (no group/device ID)', () => {
        const topic = 'cbus/write/254///gettree'; // Triple slash
        const message = null;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getNetwork()).toBe('254');
        expect(command.getApplication()).toBe(''); // Group is empty
        expect(command.getGroup()).toBe(''); // Device is empty
        expect(command.getCommandType()).toBe('gettree');
        expect(command.getPayload()).toBe('');
    });
    
     it('should handle null message gracefully for switch', () => {
        const topic = 'cbus/write/254/56/7/switch';
        const message = null;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(false);
        expect(command.getPayload()).toBe('');
    });

    it('should handle null message gracefully for commands that ignore payload', () => {
        const topic = 'cbus/write/254/56//getall';
        const message = null;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(true);
        expect(command.getPayload()).toBe('');
    });

    it('should handle undefined message gracefully for ramp', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = undefined;
        const command = new CBusCommand(topic, message);

        expect(command.isValid()).toBe(false);
        expect(command.getPayload()).toBe('');
        expect(command.getLevel()).toBeNull();
        expect(command.getRampTime()).toBeNull();
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
        expect(command.getLevel()).toBe(255);
        expect(command.getLevel()).toBe(255);
    });

    it('should clamp ramp percentage level < 0', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('-50'); // -50%
        const command = new CBusCommand(topic, message);
        expect(command.getLevel()).toBe(0);
        expect(command.getLevel()).toBe(0);
    });

    it('should return null for levels if message is non-numeric for ramp/switch', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('fifty');
        const command = new CBusCommand(topic, message);
        expect(command.getLevel()).toBeNull();
        expect(command.getLevel()).toBeNull();
    });
    
    it('should return null for levels if message is numeric but command type is not ramp/switch', () => {
        // Example: A hypothetical command that takes a number but isn't ramp/switch
        const topic = 'cbus/write/254/56/8/setvalue'; 
        const message = Buffer.from('42');
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(true);
        expect(command.getCommandType()).toBe('setvalue');
        expect(command.getLevel()).toBeNull(); // Level calculation only applies to ramp/switch
        expect(command.getLevel()).toBeNull(); // RawLevel calculation only applies to ramp
    });

     it('should parse ramp time correctly with spaces', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from(' 75 , 3m '); // Spaces around comma and time
        const command = new CBusCommand(topic, message);
        expect(command.isValid()).toBe(true);
        expect(command.getLevel()).toBe(Math.round(75 * 255 / 100));
        expect(command.getLevel()).toBe(Math.round(75 * 255 / 100));
        expect(command.getRampTime()).toBe('3m');
    });
    
     it('should return null ramp time if only level specified', () => {
        const topic = 'cbus/write/254/56/8/ramp';
        const message = Buffer.from('50'); 
        const command = new CBusCommand(topic, message);
        expect(command.getRampTime()).toBeNull();
    });

    // === Shared Logger ===

    it('should share a single logger instance across all CBusCommand instances', () => {
        const cmd1 = new CBusCommand('cbus/write/254/56/1/switch', 'ON');
        const cmd2 = new CBusCommand('cbus/write/254/56/2/ramp', '50');
        const cmd3 = new CBusCommand('cbus/write/254/56/3/switch', 'OFF');
        expect(cmd1._logger).toBe(cmd2._logger);
        expect(cmd2._logger).toBe(cmd3._logger);
    });

    // === Tests for new-style getter methods (will remain after simplification) ===
    describe('New-style getter methods', () => {
        it('should provide correct values via getNetwork()', () => {
            const command = new CBusCommand('cbus/write/254/56/7/switch', 'ON');
            expect(command.getNetwork()).toBe('254');
        });

        it('should provide correct values via getApplication()', () => {
            const command = new CBusCommand('cbus/write/254/56/7/switch', 'ON');
            expect(command.getApplication()).toBe('56');
        });

        it('should provide correct values via getGroup()', () => {
            const command = new CBusCommand('cbus/write/254/56/7/switch', 'ON');
            expect(command.getGroup()).toBe('7');
        });

        it('should provide correct values via getCommandType()', () => {
            const switchCmd = new CBusCommand('cbus/write/254/56/7/switch', 'ON');
            const rampCmd = new CBusCommand('cbus/write/254/56/7/ramp', '50');
            const getAllCmd = new CBusCommand('cbus/write/254/56//getall', '');
            
            expect(switchCmd.getCommandType()).toBe('switch');
            expect(rampCmd.getCommandType()).toBe('ramp');
            expect(getAllCmd.getCommandType()).toBe('getall');
        });

        it('should provide correct values via getLevel()', () => {
            const switchOnCmd = new CBusCommand('cbus/write/254/56/7/switch', 'ON');
            const switchOffCmd = new CBusCommand('cbus/write/254/56/7/switch', 'OFF');
            const rampCmd = new CBusCommand('cbus/write/254/56/7/ramp', '75');
            const increaseCmd = new CBusCommand('cbus/write/254/56/7/ramp', 'INCREASE');
            
            expect(switchOnCmd.getLevel()).toBe(255);
            expect(switchOffCmd.getLevel()).toBe(0);
            expect(rampCmd.getLevel()).toBe(Math.round(75 * 255 / 100));
            expect(increaseCmd.getLevel()).toBe('INCREASE');
        });

        it('should provide correct values via getRampTime()', () => {
            const rampCmd = new CBusCommand('cbus/write/254/56/7/ramp', '50,3s');
            const rampCmdNoTime = new CBusCommand('cbus/write/254/56/7/ramp', '50');
            
            expect(rampCmd.getRampTime()).toBe('3s');
            expect(rampCmdNoTime.getRampTime()).toBeNull();
        });

        it('should provide correct values via getTopic()', () => {
            const topic = 'cbus/write/254/56/7/switch';
            const command = new CBusCommand(topic, 'ON');
            expect(command.getTopic()).toBe(topic);
        });

        it('should provide correct values via getPayload()', () => {
            const payload = 'ON';
            const command = new CBusCommand('cbus/write/254/56/7/switch', payload);
            expect(command.getPayload()).toBe(payload);
        });

        it('should handle invalid commands correctly via getter methods', () => {
            const invalidCmd = new CBusCommand('invalid/topic', 'payload');
            expect(invalidCmd.isValid()).toBe(false);
            expect(invalidCmd.getNetwork()).toBeNull();
            expect(invalidCmd.getApplication()).toBeNull();
            expect(invalidCmd.getGroup()).toBeNull();
            expect(invalidCmd.getCommandType()).toBeNull();
            expect(invalidCmd.getLevel()).toBeNull();
            expect(invalidCmd.getRampTime()).toBeNull();
        });

        it('should handle buffer inputs correctly via getter methods', () => {
            const command = new CBusCommand(
                Buffer.from('cbus/write/254/56/7/ramp'), 
                Buffer.from('25,2s')
            );
            expect(command.isValid()).toBe(true);
            expect(command.getNetwork()).toBe('254');
            expect(command.getApplication()).toBe('56');
            expect(command.getGroup()).toBe('7');
            expect(command.getCommandType()).toBe('ramp');
            expect(command.getLevel()).toBe(Math.round(25 * 255 / 100));
            expect(command.getRampTime()).toBe('2s');
        });
    });

    // === Ramp Time Validation (Command Injection Prevention) ===
    describe('Ramp time validation', () => {
        it('should accept valid ramp time with seconds', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4s');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('4s');
        });

        it('should accept valid ramp time with minutes', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,2m');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('2m');
        });

        it('should accept valid ramp time with hours', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,1h');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('1h');
        });

        it('should accept valid ramp time with milliseconds', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,500ms');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('500ms');
        });

        it('should accept bare numeric ramp time', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('4');
        });

        it('should accept decimal ramp time', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,1.5s');
            expect(command.isValid()).toBe(true);
            expect(command.getRampTime()).toBe('1.5s');
        });

        it('should reject ramp time with newline (command injection)', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4s\nON //HOME/254/56/99');
            expect(command.isValid()).toBe(false);
            expect(command.getRampTime()).toBeNull();
        });

        it('should reject ramp time with carriage return', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4s\rOFF //HOME/254/56/1');
            expect(command.isValid()).toBe(false);
            expect(command.getRampTime()).toBeNull();
        });

        it('should reject ramp time with spaces (potential injection)', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4s DELETE //HOME');
            expect(command.isValid()).toBe(false);
            expect(command.getRampTime()).toBeNull();
        });

        it('should reject ramp time with semicolons', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,4s;ON //HOME/254/56/1');
            expect(command.isValid()).toBe(false);
            expect(command.getRampTime()).toBeNull();
        });

        it('should reject ramp time with letters only', () => {
            const command = new CBusCommand('cbus/write/254/56/8/ramp', '50,abc');
            expect(command.isValid()).toBe(false);
            expect(command.getRampTime()).toBeNull();
        });
    });

    // === Cover Position Commands ===
    describe('Cover position commands', () => {
        it('should parse a valid "position" command with percentage', () => {
            const topic = 'cbus/write/254/203/1/position';
            const message = Buffer.from('50'); // 50% position
            const command = new CBusCommand(topic, message);

            expect(command.isValid()).toBe(true);
            expect(command.getNetwork()).toBe('254');
            expect(command.getApplication()).toBe('203');
            expect(command.getGroup()).toBe('1');
            expect(command.getCommandType()).toBe('position');
            expect(command.getLevel()).toBe(Math.round(50 * 255 / 100)); // 128
        });

        it('should parse position 0 (fully closed)', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', '0');
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBe(0);
        });

        it('should parse position 100 (fully open)', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', '100');
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBe(255);
        });

        it('should clamp position > 100', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', '150');
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBe(255);
        });

        it('should clamp position < 0', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', '-20');
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBe(0);
        });

        it('should return null level for non-numeric position', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', 'halfway');
            // Topic is valid, but level parsing fails
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBeNull();
        });

        it('should handle decimal positions', () => {
            const command = new CBusCommand('cbus/write/254/203/1/position', '33.5');
            expect(command.isValid()).toBe(true);
            expect(command.getLevel()).toBe(Math.round(33.5 * 255 / 100)); // 85
        });
    });

    // === Cover Stop Commands ===
    describe('Cover stop commands', () => {
        it('should parse a valid "stop" command', () => {
            const topic = 'cbus/write/254/203/1/stop';
            const message = Buffer.from('STOP');
            const command = new CBusCommand(topic, message);

            expect(command.isValid()).toBe(true);
            expect(command.getNetwork()).toBe('254');
            expect(command.getApplication()).toBe('203');
            expect(command.getGroup()).toBe('1');
            expect(command.getCommandType()).toBe('stop');
        });

        it('should parse stop command with empty payload', () => {
            const command = new CBusCommand('cbus/write/254/203/1/stop', '');
            expect(command.isValid()).toBe(true);
            expect(command.getCommandType()).toBe('stop');
        });

        it('should parse stop command with null payload', () => {
            const command = new CBusCommand('cbus/write/254/203/1/stop', null);
            expect(command.isValid()).toBe(true);
            expect(command.getCommandType()).toBe('stop');
        });
    });

}); 