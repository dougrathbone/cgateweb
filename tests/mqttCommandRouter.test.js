const MqttCommandRouter = require('../src/mqttCommandRouter');
const DeviceStateManager = require('../src/deviceStateManager');

describe('MqttCommandRouter', () => {
    let router;
    let mockQueue;
    let deviceStateManager;
    let mockInternalEmitter;
    let queueSpy;

    beforeEach(() => {
        mockQueue = {
            add: jest.fn()
        };
        // Relative-level operations are owned by DeviceStateManager; the router
        // delegates to it. Share its event emitter so level responses reach the
        // registered handlers (matches the wiring in CgateWebBridge).
        deviceStateManager = new DeviceStateManager({ settings: {} });
        mockInternalEmitter = deviceStateManager.getEventEmitter();

        router = new MqttCommandRouter({
            cbusname: 'TestProject',
            ha_discovery_enabled: true,
            internalEventEmitter: mockInternalEmitter,
            deviceStateManager,
            cgateCommandQueue: mockQueue
        });

        queueSpy = jest.spyOn(mockQueue, 'add');
    });

    afterEach(() => {
        deviceStateManager.shutdown();
    });

    afterEach(() => {
        queueSpy.mockRestore();
    });

    describe('security panel arming (cbus/write/{net}/{app}/panel/arm)', () => {
        beforeEach(() => {
            router.settings.cbus_security_app_id = '208';
            router.settings.cbus_security_control_enabled = true;
            // Forcing an arm past an open zone is a second opt-in on top of
            // control, so the ARM_CUSTOM_BYPASS routing tests below have to
            // turn it on explicitly. Everything else here is unaffected.
            router.settings.cbus_security_bypass_enabled = true;
        });

        // C-Gate manual §4.5.177 takes arm-mode keywords, not the application
        // spec's numeric values. 1.23.0/1.23.1 sent numbers and every arm came
        // back "405 Parameter out of range (bad arm mode)" (#42).
        it('maps HA command payloads to C-Gate arm-mode keywords', () => {
            const cases = { ARM_AWAY: 'away', ARM_NIGHT: 'night', ARM_HOME: 'day', ARM_VACATION: 'vacation' };
            for (const [payload, mode] of Object.entries(cases)) {
                mockQueue.add.mockClear();
                router.routeMessage('cbus/write/254/208/panel/arm', payload);
                expect(mockQueue.add).toHaveBeenCalledTimes(1);
                expect(mockQueue.add).toHaveBeenCalledWith(`security arm //TestProject/254/208 ${mode}\n`);
            }
        });

        it('never sends a numeric arm mode, which C-Gate rejects', () => {
            for (const payload of ['ARM_AWAY', 'ARM_NIGHT', 'ARM_HOME', 'ARM_VACATION']) {
                mockQueue.add.mockClear();
                router.routeMessage('cbus/write/254/208/panel/arm', payload);
                const sent = mockQueue.add.mock.calls[0][0];
                expect(sent).not.toMatch(/security arm \S+ \d+\s*$/);
            }
        });

        it('logs every arm at INFO', () => {
            const infoSpy = jest.spyOn(router.logger, 'info');
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_AWAY');
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Security arm: 254/208 -> away (ARM_AWAY)'));
            infoSpy.mockRestore();
        });

        // Regression for 1.23.0, which sent `security arm ... 0` for DISARM.
        // Spec §5.5.2.3 reserves arm mode $00, so that put an invalid argument
        // on the bus and the panel ignored it (#42). Nothing may reach the queue.
        it('never puts reserved arm mode 0 on the bus for DISARM', () => {
            router.settings.cbus_security_disarm_enabled = true;
            router.routeMessage('cbus/write/254/208/panel/arm', '{"action":"DISARM","code":"1234"}');
            for (const call of mockQueue.add.mock.calls) {
                expect(call[0]).not.toMatch(/security arm /);
            }
        });

        it('ignores DISARM when disarm is not enabled', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/arm', 'DISARM');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Security disarm is disabled'));
            warnSpy.mockRestore();
        });

        it('rejects unknown payloads with a warning and no command', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            // ARM_CUSTOM_BYPASS used to be the example here; it is a real
            // action now (#62), so this needs a genuinely unsupported one.
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_TRIGGER');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown security command'));
            warnSpy.mockRestore();
        });

        // #62: Home Assistant's native alarm-panel action for arming past
        // whatever is in the way. It must reach the same '#' keypress as the
        // dedicated bypass button, not a second implementation.
        it('routes ARM_CUSTOM_BYPASS to the # keypress', () => {
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_CUSTOM_BYPASS');
            expect(mockQueue.add).toHaveBeenCalledTimes(1);
            // '#' is $23.
            expect(mockQueue.add).toHaveBeenCalledWith('security emulate_keypad //TestProject/254/208 $23\n');
        });

        it('sends the identical command whether bypass comes from the button or the panel', () => {
            router.routeMessage('cbus/write/254/208/panel/bypass', '');
            const fromButton = mockQueue.add.mock.calls.map(c => c[0]);
            mockQueue.add.mockClear();
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_CUSTOM_BYPASS');
            // Asserted non-empty as well as equal: when bypass is gated off
            // both routes send nothing, and "equal" alone would pass while
            // testing nothing at all.
            expect(fromButton).toHaveLength(1);
            expect(mockQueue.add.mock.calls.map(c => c[0])).toEqual(fromButton);
        });

        it('ignores ARM_CUSTOM_BYPASS when control is disabled', () => {
            router.settings.cbus_security_control_enabled = false;
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_CUSTOM_BYPASS');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        it('ignores ARM_CUSTOM_BYPASS when control is on but bypass is not', () => {
            // The gate that this whole setting exists for. Control being on
            // means "you may arm the alarm"; it must not silently also mean
            // "you may arm it past an open door".
            router.settings.cbus_security_bypass_enabled = false;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_CUSTOM_BYPASS');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Security zone bypass is disabled'));
            warnSpy.mockRestore();
        });

        it('still arms normally when bypass is disabled', () => {
            router.settings.cbus_security_bypass_enabled = false;
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_AWAY');
            expect(mockQueue.add).toHaveBeenCalledWith('security arm //TestProject/254/208 away\n');
        });

        it('ignores the command when control is disabled', () => {
            router.settings.cbus_security_control_enabled = false;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_AWAY');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Security panel control is disabled'));
            warnSpy.mockRestore();
        });

        it('ignores arm commands for a different application', () => {
            router.routeMessage('cbus/write/254/209/panel/arm', 'ARM_AWAY');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        it('does not reach the generic command parser for the panel topic', () => {
            // 'panel' is not a numeric group — without the direct route this
            // would log "Invalid MQTT command topic format".
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_AWAY');
            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Invalid MQTT command'));
            warnSpy.mockRestore();
        });
    });

    describe('security zone bypass (cbus/write/{net}/{app}/panel/bypass)', () => {
        beforeEach(() => {
            router.settings.cbus_security_app_id = '208';
            router.settings.cbus_security_control_enabled = true;
            router.settings.cbus_security_bypass_enabled = true;
        });

        it('sends the # keypress via emulate_keypad in $hex form when control is enabled', () => {
            // '#' is ASCII 0x23; the $hex form is the verified-working C-Gate
            // key encoding (#51). This is the virtual bypass key (#42).
            router.routeMessage('cbus/write/254/208/panel/bypass', 'PRESS');
            expect(mockQueue.add).toHaveBeenCalledWith('security emulate_keypad //TestProject/254/208 $23\n');
        });

        it('warns and sends nothing when control is disabled', () => {
            router.settings.cbus_security_control_enabled = false;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/bypass', 'PRESS');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Security panel control is disabled'));
            warnSpy.mockRestore();
        });

        it('ignores bypass for a different application', () => {
            router.routeMessage('cbus/write/254/209/panel/bypass', 'PRESS');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        it('warns and sends nothing when bypass is disabled but control is on', () => {
            router.settings.cbus_security_bypass_enabled = false;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/208/panel/bypass', 'PRESS');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Security zone bypass is disabled'));
            warnSpy.mockRestore();
        });

        it('is off unless explicitly enabled', () => {
            // Default-deny is the point of the setting: an install that only
            // turned on control must not get force-arm thrown in.
            delete router.settings.cbus_security_bypass_enabled;
            router.routeMessage('cbus/write/254/208/panel/bypass', 'PRESS');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });
    });

    // #51: C-Bus has no disarm command, so a disarm is the PIN replayed through
    // `security emulate_keypad`, one keypress per digit. Home Assistant's own
    // keypad collects the PIN and sends it in the command payload.
    describe('security panel disarm via keypad emulation', () => {
        const TOPIC = 'cbus/write/254/208/panel/arm';
        const PIN = '1234';

        beforeEach(() => {
            router.settings.cbus_security_app_id = '208';
            router.settings.cbus_security_control_enabled = true;
            router.settings.cbus_security_disarm_enabled = true;
        });

        function sentCommands() {
            return mockQueue.add.mock.calls.map(c => c[0]);
        }

        // cgateweb cannot tell a right PIN from a wrong one - only the panel
        // can - so without a limit anything able to publish to this topic could
        // walk the whole PIN space through Emulate Keypad at whatever rate the
        // command queue allows.
        describe('brute-force limiting', () => {
            const disarm = (code = PIN) => router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code }));

            beforeEach(() => {
                router.settings.securityDisarmMaxAttempts = 3;
                router.settings.securityDisarmAttemptWindowMs = 600000;
            });

            it('lets attempts through up to the limit', () => {
                for (let i = 0; i < 3; i += 1) {
                    mockQueue.add.mockClear();
                    disarm();
                    expect(sentCommands()).toHaveLength(PIN.length + 1);
                }
            });

            it('refuses further attempts once the limit is reached', () => {
                for (let i = 0; i < 3; i += 1) disarm();
                mockQueue.add.mockClear();
                const warnSpy = jest.spyOn(router.logger, 'warn');
                disarm();
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too many disarm attempts'));
                warnSpy.mockRestore();
            });

            it('counts a correct PIN too', () => {
                // There is no "successful disarm" signal to reset on: the panel
                // answers with a broadcast, not a reply. Inferring success from
                // the state machine would let anything that looked like a
                // disarm clear the counter, which fails in the wrong direction.
                for (let i = 0; i < 3; i += 1) disarm('9999');
                mockQueue.add.mockClear();
                disarm(PIN);
                expect(mockQueue.add).not.toHaveBeenCalled();
            });

            it('limits per network/application, not globally', () => {
                for (let i = 0; i < 3; i += 1) disarm();
                mockQueue.add.mockClear();
                router.settings.cbus_security_app_id = '208';
                router.routeMessage('cbus/write/253/208/panel/arm', JSON.stringify({ action: 'DISARM', code: PIN }));
                expect(sentCommands()).toHaveLength(PIN.length + 1);
            });

            it('lets attempts through again once the window passes', () => {
                const realNow = Date.now;
                let t = 1_000_000;
                Date.now = () => t;
                try {
                    for (let i = 0; i < 3; i += 1) disarm();
                    mockQueue.add.mockClear();
                    disarm();
                    expect(mockQueue.add).not.toHaveBeenCalled();

                    t += 600001;
                    mockQueue.add.mockClear();
                    disarm();
                    expect(sentCommands()).toHaveLength(PIN.length + 1);
                } finally {
                    Date.now = realNow;
                }
            });

            it('does not spend an attempt on a payload that never reaches the panel', () => {
                // A malformed or over-long code is rejected before the counter,
                // so a broken automation cannot lock out the household.
                for (let i = 0; i < 10; i += 1) {
                    router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: 'abcd' }));
                    router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '' }));
                }
                mockQueue.add.mockClear();
                disarm();
                expect(sentCommands()).toHaveLength(PIN.length + 1);
            });

            it('defaults to a limit even with nothing configured', () => {
                delete router.settings.securityDisarmMaxAttempts;
                delete router.settings.securityDisarmAttemptWindowMs;
                for (let i = 0; i < 10; i += 1) disarm();
                mockQueue.add.mockClear();
                disarm();
                expect(mockQueue.add).not.toHaveBeenCalled();
            });
        });

        // Verified against real hardware on #51: keys go as C-Gate's $xx hex,
        // and the code is not submitted until the # key follows it. 1.24.0 sent
        // bare decimals and no terminator, and the panel simply ignored it.
        it('types the PIN then presses #, all as $xx hex keys', () => {
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: PIN }));
            // '1'..'4' are $31..$34, '#' is $23.
            expect(sentCommands()).toEqual([
                'security emulate_keypad //TestProject/254/208 $31\n',
                'security emulate_keypad //TestProject/254/208 $32\n',
                'security emulate_keypad //TestProject/254/208 $33\n',
                'security emulate_keypad //TestProject/254/208 $34\n',
                'security emulate_keypad //TestProject/254/208 $23\n'
            ]);
        });

        it('always finishes with the accept key, whatever the PIN length', () => {
            for (const code of ['12', '123456']) {
                mockQueue.add.mockClear();
                router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code }));
                const sent = sentCommands();
                expect(sent).toHaveLength(code.length + 1);
                expect(sent[sent.length - 1]).toBe('security emulate_keypad //TestProject/254/208 $23\n');
            }
        });

        it('preserves digit order, including repeated digits', () => {
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '1102' }));
            expect(sentCommands().map(c => c.trim().split(' ').pop()))
                .toEqual(['$31', '$31', '$30', '$32', '$23']);
        });

        // The whole point of REMOTE_CODE is that the PIN is never stored. It
        // must not end up in the log either.
        it('never writes the PIN to the log', () => {
            const infoSpy = jest.spyOn(router.logger, 'info');
            const warnSpy = jest.spyOn(router.logger, 'warn');
            const errorSpy = jest.spyOn(router.logger, 'error');

            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '9753' }));

            const logged = [infoSpy, warnSpy, errorSpy]
                .flatMap(spy => spy.mock.calls.flat())
                .join(' ');
            expect(logged).not.toContain('9753');
            expect(logged).toContain('sent 4 digits + accept key');

            infoSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        });

        it('does not echo a malformed JSON payload, which may hold a PIN', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage(TOPIC, '{"action":"DISARM","code":"4321"');
            expect(mockQueue.add).not.toHaveBeenCalled();
            const logged = warnSpy.mock.calls.flat().join(' ');
            expect(logged).not.toContain('4321');
            expect(logged).toContain('payload withheld');
            warnSpy.mockRestore();
        });

        it('rejects a non-numeric code without typing it at the panel', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            // Keypad emulation can send any ASCII character, so a non-digit
            // payload must not be forwarded as keystrokes.
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '12*4' }));
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('digits only'));
            warnSpy.mockRestore();
        });

        it('rejects an absurdly long code rather than queueing hundreds of keypresses', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '1'.repeat(64) }));
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('longer than'));
            warnSpy.mockRestore();
        });

        it('explains a disarm that arrived with no code at all', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: '' }));
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('carried no PIN'));
            warnSpy.mockRestore();
        });

        it('sends nothing when disarm is off, even with a valid PIN', () => {
            router.settings.cbus_security_disarm_enabled = false;
            router.routeMessage(TOPIC, JSON.stringify({ action: 'DISARM', code: PIN }));
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        it('still accepts bare arm payloads once the template is in play', () => {
            // Existing automations publish `ARM_AWAY` with no JSON wrapper;
            // enabling disarm must not break them.
            router.routeMessage(TOPIC, 'ARM_AWAY');
            expect(sentCommands()).toEqual(['security arm //TestProject/254/208 away\n']);
        });

        it('accepts the JSON form for arming, where the code is empty', () => {
            router.routeMessage(TOPIC, JSON.stringify({ action: 'ARM_AWAY', code: '' }));
            expect(sentCommands()).toEqual(['security arm //TestProject/254/208 away\n']);
        });
    });

    describe('measurement data injection (cbus/write/{net}/{app}/{device}/{channel}/data)', () => {
        beforeEach(() => {
            router.settings.cbus_measurement_app_id = '228';
        });

        // Confirmed working syntax via live end-to-end testing against real
        // C-Gate and real DLT input units.
        it('builds a MEASUREMENT DATA command from a value,multiplier,units payload', () => {
            router.routeMessage('cbus/write/254/228/0/0/data', '5042,0,38');
            expect(mockQueue.add).toHaveBeenCalledTimes(1);
            expect(mockQueue.add).toHaveBeenCalledWith('MEASUREMENT DATA //TestProject/254/228/0/0 5042 0 38\n');
        });

        it('defaults multiplier to 0 and units to 0 (°C) when omitted', () => {
            router.routeMessage('cbus/write/254/228/1/0/data', '215');
            expect(mockQueue.add).toHaveBeenCalledWith('MEASUREMENT DATA //TestProject/254/228/1/0 215 0 0\n');
        });

        it('handles a negative value (sub-zero temperature)', () => {
            router.routeMessage('cbus/write/254/228/1/0/data', '-55,-1,0');
            expect(mockQueue.add).toHaveBeenCalledWith('MEASUREMENT DATA //TestProject/254/228/1/0 -55 -1 0\n');
        });

        it('logs every injection at INFO', () => {
            const infoSpy = jest.spyOn(router.logger, 'info');
            router.routeMessage('cbus/write/254/228/0/0/data', '5042,0,38');
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Measurement data: 254/228/0/0 -> 5042'));
            infoSpy.mockRestore();
        });

        it('rejects an out-of-range value', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/228/0/0/data', '99999,0,38');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid measurement value'));
            warnSpy.mockRestore();
        });

        it('rejects an unknown units code', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/228/0/0/data', '5042,0,100');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown measurement units code'));
            warnSpy.mockRestore();
        });

        it('ignores the command when the feature is disabled', () => {
            router.settings.cbus_measurement_app_id = null;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/228/0/0/data', '5042,0,38');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unconfigured application'));
            warnSpy.mockRestore();
        });

        it('ignores commands for a different application', () => {
            router.routeMessage('cbus/write/254/229/0/0/data', '5042,0,38');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        it('does not reach the generic command parser for the 4-segment data topic', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/228/0/0/data', '5042,0,38');
            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Invalid MQTT command'));
            warnSpy.mockRestore();
        });
    });

    // Every other write topic is range-checked by CBusCommand, which these three
    // never reach: they match their own regex in routeMessage and return before
    // it is constructed. So "cbus/write/999/208/panel/arm" used to produce
    // "security arm //HOME/999/208 away" for a network C-Bus cannot express.
    // C-Gate rejects it, so the damage was malformed commands and log noise -
    // but it left the write side lagging the inbound side, which was hardened
    // for exactly this (CBusEvent._applyAddressComponents).
    describe('C-Bus address range validation on the topics that bypass CBusCommand', () => {
        let warnSpy;

        beforeEach(() => {
            router.settings.cbus_security_app_id = '208';
            router.settings.cbus_security_control_enabled = true;
            router.settings.cbus_security_bypass_enabled = true;
            router.settings.cbus_measurement_app_id = '228';
            warnSpy = jest.spyOn(router.logger, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        const sentCommands = () => mockQueue.add.mock.calls.map(c => c[0]);

        describe('reproduction from the bug report', () => {
            it('sends nothing for cbus/write/999/208/panel/arm', () => {
                // Arrange: the exact topic and payload captured in the report.
                // Act
                router.routeMessage('cbus/write/999/208/panel/arm', 'ARM_AWAY');

                // Assert: not merely "a warning was logged" - the malformed
                // command must never be queued for C-Gate.
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(sentCommands()).not.toContain('security arm //TestProject/999/208 away\n');
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cbus/write/999/208/panel/arm'));
            });

            it('sends nothing for cbus/write/999/228/5/1/data', () => {
                router.routeMessage('cbus/write/999/228/5/1/data', '123,-1,38');

                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(sentCommands()).not.toContain('MEASUREMENT DATA //TestProject/999/228/5/1 123 -1 38\n');
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cbus/write/999/228/5/1/data'));
            });
        });

        describe('security arm topic', () => {
            const arm = (network, application = '208') =>
                router.routeMessage(`cbus/write/${network}/${application}/panel/arm`, 'ARM_AWAY');

            it('accepts the valid network boundaries and still builds the same command', () => {
                // 0 and 254 are the ends of the range; 255 is reserved, so the
                // network bound is one below the single-byte maximum.
                for (const network of ['0', '254']) {
                    mockQueue.add.mockClear();
                    arm(network);
                    expect(sentCommands()).toEqual([`security arm //TestProject/${network}/208 away\n`]);
                }
            });

            it('accepts the one- and two-digit network shapes the regex allows', () => {
                for (const network of ['5', '99']) {
                    mockQueue.add.mockClear();
                    arm(network);
                    expect(sentCommands()).toEqual([`security arm //TestProject/${network}/208 away\n`]);
                }
            });

            it('rejects network 255, the first value above the maximum', () => {
                arm('255');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network address "255"'));
            });

            it('rejects every out-of-range network the regex can match', () => {
                for (const network of ['255', '256', '300', '999']) {
                    mockQueue.add.mockClear();
                    arm(network);
                    expect(mockQueue.add).not.toHaveBeenCalled();
                }
            });

            it('accepts application 255, the top of the single-byte range', () => {
                // The handler already refuses an application that is not the
                // configured one, so reaching the range check at all means
                // configuring the panel there.
                router.settings.cbus_security_app_id = '255';
                arm('254', '255');
                expect(sentCommands()).toEqual(['security arm //TestProject/254/255 away\n']);
            });

            it('rejects an out-of-range application even when it is the configured one', () => {
                // The configured-application check constrains the application to
                // whatever the user set - it does not constrain it to a legal
                // C-Bus address. A misconfigured app id must not become a
                // malformed command.
                router.settings.cbus_security_app_id = '256';
                arm('254', '256');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('application address "256"'));
            });

            it('rejects a rejected address before the disarm path can type a PIN', () => {
                // Disarm is the costliest thing on this topic - it replays the
                // PIN keypress by keypress - so the address check has to come
                // first, not inside the arm branch.
                router.settings.cbus_security_disarm_enabled = true;
                router.routeMessage('cbus/write/999/208/panel/arm', JSON.stringify({ action: 'DISARM', code: '1234' }));
                expect(mockQueue.add).not.toHaveBeenCalled();
            });

            it('queues nothing for a four-digit network, which the topic regex never matches', () => {
                // Falls through to the generic parser instead, which rejects it -
                // recorded so a future regex relaxation does not silently open a
                // path that skips the range check.
                router.routeMessage('cbus/write/1000/208/panel/arm', 'ARM_AWAY');
                expect(mockQueue.add).not.toHaveBeenCalled();
            });
        });

        describe('security bypass topic', () => {
            const bypass = (network, application = '208') =>
                router.routeMessage(`cbus/write/${network}/${application}/panel/bypass`, 'PRESS');

            it('accepts the valid network boundaries and still sends the # keypress', () => {
                for (const network of ['0', '254']) {
                    mockQueue.add.mockClear();
                    bypass(network);
                    expect(sentCommands()).toEqual([`security emulate_keypad //TestProject/${network}/208 $23\n`]);
                }
            });

            it('rejects network 255, the first value above the maximum', () => {
                bypass('255');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network address "255"'));
            });

            it('rejects the reproduction network 999', () => {
                bypass('999');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cbus/write/999/208/panel/bypass'));
            });

            it('rejects an out-of-range application even when it is the configured one', () => {
                router.settings.cbus_security_app_id = '999';
                bypass('254', '999');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('application address "999"'));
            });

            it('still reaches the same bypass path via the alarm panel action', () => {
                // ARM_CUSTOM_BYPASS funnels through the arm topic; the address
                // check there must not have broken the valid case.
                router.routeMessage('cbus/write/254/208/panel/arm', 'ARM_CUSTOM_BYPASS');
                expect(sentCommands()).toEqual(['security emulate_keypad //TestProject/254/208 $23\n']);
            });
        });

        describe('measurement data topic', () => {
            // Device ID and Channel are one argument byte each in the SAL
            // message (docs/Measurement Application.md §28.5.1.1), so both are
            // bounded 0-255 like an application or group. The spec's "no more
            // than 10 measuring devices per network" note (§28.5.4) is
            // engineering guidance, not an address bound, so it is not enforced.
            const data = (network, application, device, channel, payload = '5042,0,38') =>
                router.routeMessage(`cbus/write/${network}/${application}/${device}/${channel}/data`, payload);

            it('accepts the valid boundaries on every component', () => {
                data('0', '228', '0', '0');
                expect(sentCommands()).toEqual(['MEASUREMENT DATA //TestProject/0/228/0/0 5042 0 38\n']);

                mockQueue.add.mockClear();
                data('254', '228', '255', '255');
                expect(sentCommands()).toEqual(['MEASUREMENT DATA //TestProject/254/228/255/255 5042 0 38\n']);
            });

            it('accepts the multi-digit device and channel shapes the regex allows', () => {
                data('254', '228', '10', '100');
                expect(sentCommands()).toEqual(['MEASUREMENT DATA //TestProject/254/228/10/100 5042 0 38\n']);
            });

            it('rejects network 255, the first value above the maximum', () => {
                data('255', '228', '0', '0');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network address "255"'));
            });

            it('rejects device 256, the first value above the maximum', () => {
                data('254', '228', '256', '0');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('device address "256"'));
            });

            it('rejects channel 256, the first value above the maximum', () => {
                data('254', '228', '0', '256');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('channel address "256"'));
            });

            it('rejects an out-of-range application even when it is the configured one', () => {
                router.settings.cbus_measurement_app_id = '256';
                data('254', '256', '0', '0');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('application address "256"'));
            });

            it('rejects an out-of-range address before the payload is even parsed', () => {
                // Otherwise a bad address plus a good payload reads as a payload
                // problem in the log, and vice versa.
                data('999', '228', '0', '0', 'not-a-number');
                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Invalid measurement value'));
            });

            it('queues nothing for a four-digit component, which the topic regex never matches', () => {
                router.routeMessage('cbus/write/1000/228/0/0/data', '5042,0,38');
                expect(mockQueue.add).not.toHaveBeenCalled();
            });
        });
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

        it('should ignore commands with malformed address segments', () => {
            const processSpy = jest.spyOn(router, '_processCommand');

            router.routeMessage('cbus/write/254abc/56/1/switch', 'ON');
            router.routeMessage('cbus/write/254/56x/1/switch', 'ON');
            router.routeMessage('cbus/write/254/56/1x/switch', 'ON');
            router.routeMessage('cbus/write/25 4/56/1/switch', 'ON');
            router.routeMessage('cbus/write/254/1000/1/switch', 'ON');

            expect(processSpy).not.toHaveBeenCalled();
            expect(queueSpy).not.toHaveBeenCalled();
        });
    });

    describe('Command Handlers', () => {
        describe('GetTree Commands', () => {
            it('should handle gettree commands', () => {
                const emitSpy = jest.spyOn(router, 'emit');
                
                router.routeMessage('cbus/write/254/0/0/gettree', '');
                
                expect(emitSpy).toHaveBeenCalledWith('treeRequest', '254');
            });

            it('does not directly queue TREEXML (avoids a duplicate untracked tree that lands as an "unknown" network, issue #25)', () => {
                // A manual gettree must go through the treeRequest -> queueTreeRequest
                // path only. If the router ALSO queued the TREEXML directly, C-Gate
                // would return two tree responses: the first attributed to the
                // network, the second (with an empty pending queue) falling back to
                // the "unknown" network and publishing duplicate entities.
                router.routeMessage('cbus/write/254/0/0/gettree', '');

                const treexmlCalls = queueSpy.mock.calls.filter(c => String(c[0]).includes('TREEXML'));
                expect(treexmlCalls).toHaveLength(0);
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

            it('redacts MQTT secrets in invalid switch payload warnings', () => {
                const warnSpy = jest.spyOn(router.logger, 'warn');
                const command = {
                    getGroup: () => '1',
                    getTopic: () => 'cbus/write/254/56/1/switch',
                    getNetwork: () => '254',
                    getApplication: () => '56'
                };
                router._handleSwitch(command, '{"action":"DISARM","code":"1234"}');
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0][0]).toContain('Invalid payload for switch command:');
                expect(warnSpy.mock.calls[0][0]).toContain('***');
                expect(warnSpy.mock.calls[0][0]).not.toContain('1234');
                warnSpy.mockRestore();
            });

            it('should treat a STOP payload on the switch topic as a cover stop', () => {
                // Home Assistant's MQTT cover platform has no separate stop topic;
                // it publishes payload_stop ("STOP") to the command (switch) topic.
                // cgateweb must route that to TERMINATERAMP rather than dropping it.
                router.routeMessage('cbus/write/254/56/53/switch', 'STOP');

                expect(queueSpy).toHaveBeenCalledWith('TERMINATERAMP //TestProject/254/56/53\n', { priority: 'critical' });
            });

            it('does not echo state when STOP is routed as a cover stop', () => {
                const publish = jest.fn();
                router.mqttClient = { publish };
                router.routeMessage('cbus/write/254/56/53/switch', 'STOP');
                expect(publish).not.toHaveBeenCalled();
            });

            it('echoes ON/OFF to read topics so HA updates before the C-Gate event (issue #52)', () => {
                const publish = jest.fn();
                router.mqttClient = { publish };
                router.routeMessage('cbus/write/254/56/1/switch', 'ON');
                expect(publish).toHaveBeenCalledWith('cbus/read/254/56/1/state', 'ON', { qos: 0 });
                expect(publish).toHaveBeenCalledWith('cbus/read/254/56/1/level', '100', { qos: 0 });
            });
        });

        describe('Ramp Commands', () => {
            it('should handle numeric level ramp', () => {
                router.routeMessage('cbus/write/254/56/1/ramp', '75');
                
                expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/1 191\n');
            });

            it('redacts MQTT secrets in invalid ramp payload warnings', () => {
                const warnSpy = jest.spyOn(router.logger, 'warn');
                const command = {
                    getLevel: () => null,
                    getRampTime: () => null,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '1'
                };
                router._handleAbsoluteLevel(command, '//TestProject/254/56/1', '{"action":"DISARM","code":"9999"}');
                expect(queueSpy).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledTimes(1);
                expect(warnSpy.mock.calls[0][0]).toContain('Invalid payload for ramp command:');
                expect(warnSpy.mock.calls[0][0]).toContain('***');
                expect(warnSpy.mock.calls[0][0]).not.toContain('9999');
                warnSpy.mockRestore();
            });

            it('echoes dimmer level and ON to read topics before the C-Gate event (issue #52)', () => {
                const publish = jest.fn();
                router.mqttClient = { publish };
                router.routeMessage('cbus/write/254/56/1/ramp', '75');
                expect(publish).toHaveBeenCalledWith('cbus/read/254/56/1/state', 'ON', { qos: 0 });
                expect(publish).toHaveBeenCalledWith('cbus/read/254/56/1/level', '75', { qos: 0 });
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

        it('should only produce one RAMP when multiple INCREASE commands arrive before level response', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            // Three GET queries queued (one per INCREASE), but only one listener active
            expect(mockInternalEmitter.listenerCount('level')).toBe(1);

            queueSpy.mockClear();

            // Level response arrives — should produce exactly one RAMP
            mockInternalEmitter.emit('level', '254/56/1', 100);

            const rampCalls = queueSpy.mock.calls.filter(c => c[0].startsWith('RAMP'));
            expect(rampCalls).toHaveLength(1);
            expect(rampCalls[0][0]).toBe('RAMP //TestProject/254/56/1 126\n');
        });

        it('should use the latest command when INCREASE then DECREASE arrive before level response', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            router.routeMessage('cbus/write/254/56/1/ramp', 'DECREASE');

            expect(mockInternalEmitter.listenerCount('level')).toBe(1);

            queueSpy.mockClear();

            // Level response arrives — should use DECREASE (the latest command)
            mockInternalEmitter.emit('level', '254/56/1', 100);

            const rampCalls = queueSpy.mock.calls.filter(c => c[0].startsWith('RAMP'));
            expect(rampCalls).toHaveLength(1);
            expect(rampCalls[0][0]).toBe('RAMP //TestProject/254/56/1 74\n');
        });

        it('should allow independent operations for different addresses concurrently', () => {
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            router.routeMessage('cbus/write/254/56/2/ramp', 'DECREASE');

            // Two different addresses — two listeners
            expect(mockInternalEmitter.listenerCount('level')).toBe(2);

            queueSpy.mockClear();

            mockInternalEmitter.emit('level', '254/56/1', 100);
            mockInternalEmitter.emit('level', '254/56/2', 200);

            const rampCalls = queueSpy.mock.calls.filter(c => c[0].startsWith('RAMP'));
            expect(rampCalls).toHaveLength(2);
            expect(rampCalls[0][0]).toBe('RAMP //TestProject/254/56/1 126\n');
            expect(rampCalls[1][0]).toBe('RAMP //TestProject/254/56/2 174\n');
        });

        it('should clean up superseded operation timeout without firing', () => {
            jest.useFakeTimers();

            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');
            router.routeMessage('cbus/write/254/56/1/ramp', 'INCREASE');

            // Resolve the active (second) operation
            mockInternalEmitter.emit('level', '254/56/1', 100);
            expect(mockInternalEmitter.listenerCount('level')).toBe(0);

            // Advance past timeout — the superseded timeout should not fire or error
            jest.advanceTimersByTime(6000);
            expect(mockInternalEmitter.listenerCount('level')).toBe(0);

            jest.useRealTimers();
        });
    });

    describe('_queueCommand() Priority Handling', () => {
        it.each([
            ['interactive', 'RAMP //TestProject/254/203/1 128\n'],
            ['critical', 'TERMINATERAMP //TestProject/254/203/1\n'],
        ])('should pass through %s priority', (priority, cmd) => {
            router._queueCommand(cmd, priority);
            expect(queueSpy).toHaveBeenCalledWith(cmd, { priority });
        });

        it('should use bare queue add when priority is omitted', () => {
            router._queueCommand('GET //TestProject/254/56/* level\n');
            expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/* level\n');
        });
    });

    describe('Cover Position Commands', () => {
        it('should handle position command with percentage', () => {
            router.routeMessage('cbus/write/254/203/1/position', '50');
            
            // 50% of 255 = 128
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 128\n', { priority: 'interactive' });
        });

        it('should handle position 0 (fully closed)', () => {
            router.routeMessage('cbus/write/254/203/1/position', '0');
            
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 0\n', { priority: 'interactive' });
        });

        it('should handle position 100 (fully open)', () => {
            router.routeMessage('cbus/write/254/203/1/position', '100');
            
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 255\n', { priority: 'interactive' });
        });

        it('should handle partial position', () => {
            router.routeMessage('cbus/write/254/203/1/position', '75');
            
            // 75% of 255 = 191
            expect(queueSpy).toHaveBeenCalledWith('RAMP //TestProject/254/203/1 191\n', { priority: 'interactive' });
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

    describe('Trigger Commands', () => {
        it.each([
            ['ON', 255], ['100', 255], ['PRESS', 255],
            ['50', 128],
            ['0', 0],
        ])('should map trigger payload %s to C-Gate level %i', (payload, level) => {
            router.routeMessage('cbus/write/254/202/1/trigger', payload);
            expect(queueSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/202/1 ${level}\n`);
        });

        it('should reject trigger command without device ID', () => {
            router.routeMessage('cbus/write/254/202//trigger', 'ON');

            expect(queueSpy).not.toHaveBeenCalled();
        });

        it('should send ON command when scene entity activates trigger group via switch topic with ON payload', () => {
            // Scene entities use the /switch topic with ON payload to activate a C-Bus scene.
            // This verifies that the existing switch handler correctly routes ON to C-Gate ON command.
            router.routeMessage('cbus/write/254/202/1/switch', 'ON');

            expect(queueSpy).toHaveBeenCalledWith('ON //TestProject/254/202/1\n');
        });
    });

    describe('Cover Stop Commands', () => {
        it('should handle stop command', () => {
            router.routeMessage('cbus/write/254/203/1/stop', 'STOP');
            
            expect(queueSpy).toHaveBeenCalledWith('TERMINATERAMP //TestProject/254/203/1\n', { priority: 'critical' });
        });

        it('should handle stop command with empty payload', () => {
            router.routeMessage('cbus/write/254/203/1/stop', '');
            
            expect(queueSpy).toHaveBeenCalledWith('TERMINATERAMP //TestProject/254/203/1\n', { priority: 'critical' });
        });

        it('should reject stop command without device ID', () => {
            router.routeMessage('cbus/write/254/203//stop', 'STOP');

            expect(queueSpy).not.toHaveBeenCalled();
        });
    });

    describe('Cover Tilt Commands', () => {
        it.each([
            ['0', 0], ['50', 128], ['100', 255],
        ])('should map tilt %s%% to C-Gate level %i', (pct, level) => {
            router.routeMessage('cbus/write/254/204/5/tilt', pct);
            expect(queueSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/204/5 ${level}\n`, { priority: 'interactive' });
        });

        it('should reject tilt command without device ID', () => {
            router.routeMessage('cbus/write/254/204//tilt', '50');

            expect(queueSpy).not.toHaveBeenCalled();
        });

        it('should reject tilt command with invalid (non-numeric) payload', () => {
            router.routeMessage('cbus/write/254/204/5/tilt', 'invalid');

            expect(queueSpy).not.toHaveBeenCalled();
        });
    });

    describe('Cover Ramp Interpolation', () => {
        let mockMqttClient;
        let mockDeviceStateManager;
        let rampRouter;

        beforeEach(() => {
            jest.useFakeTimers();

            mockMqttClient = { publish: jest.fn() };
            mockDeviceStateManager = {
                getLevel: jest.fn().mockReturnValue(undefined)
            };

            rampRouter = new MqttCommandRouter({
                cbusname: 'TestProject',
                ha_discovery_enabled: true,
                internalEventEmitter: mockInternalEmitter,
                cgateCommandQueue: mockQueue,
                mqttClient: mockMqttClient,
                deviceStateManager: mockDeviceStateManager,
                settings: {
                    ha_discovery_cover_app_id: '203',
                    cover_ramp_duration_ms: 2000,
                    retainreads: false
                }
            });
        });

        afterEach(() => {
            rampRouter.coverRampTracker.cancelAll();
            jest.useRealTimers();
        });

        it('starts a ramp tracker entry when a position command is sent to a cover app', () => {
            rampRouter.routeMessage('cbus/write/254/203/1/position', '100');

            expect(rampRouter.coverRampTracker.isRamping('254/203/1')).toBe(true);
        });

        it('publishes interpolated position values during the ramp', () => {
            rampRouter.routeMessage('cbus/write/254/203/1/position', '100');

            jest.advanceTimersByTime(500);

            expect(mockMqttClient.publish).toHaveBeenCalled();
            const positionCall = mockMqttClient.publish.mock.calls.find(
                (c) => c[0] === 'cbus/read/254/203/1/position'
            );
            expect(positionCall).toBeDefined();
        });

        it('uses the known start level from deviceStateManager when calculating interpolation', () => {
            // Simulate device currently at 50% (level 128)
            mockDeviceStateManager.getLevel.mockReturnValue(128);

            // Command to move to 100% (level 255)
            rampRouter.routeMessage('cbus/write/254/203/1/position', '100');

            // At 500ms = 25% of 2000ms duration: level ≈ 128 + (255-128)*0.25 = 160
            jest.advanceTimersByTime(500);

            const positionCalls = mockMqttClient.publish.mock.calls.filter(
                (c) => c[0] === 'cbus/read/254/203/1/position'
            );
            expect(positionCalls.length).toBeGreaterThan(0);
            // 160/255*100 = ~63%
            const publishedValue = parseInt(positionCalls[0][1], 10);
            expect(publishedValue).toBeGreaterThan(50);
            expect(publishedValue).toBeLessThan(100);
        });

        it('cancels the ramp tracker when a stop command is received', () => {
            rampRouter.routeMessage('cbus/write/254/203/1/position', '100');
            expect(rampRouter.coverRampTracker.isRamping('254/203/1')).toBe(true);

            rampRouter.routeMessage('cbus/write/254/203/1/stop', 'STOP');
            expect(rampRouter.coverRampTracker.isRamping('254/203/1')).toBe(false);
        });

        it('replaces an existing ramp when a new position command arrives for the same cover', () => {
            rampRouter.routeMessage('cbus/write/254/203/1/position', '100');
            expect(rampRouter.coverRampTracker.isRamping('254/203/1')).toBe(true);

            // New position command mid-ramp
            rampRouter.routeMessage('cbus/write/254/203/1/position', '0');
            // Should still be ramping (new ramp replaced old one)
            expect(rampRouter.coverRampTracker.isRamping('254/203/1')).toBe(true);
        });

        it('does not start a ramp when mqttClient is not configured', () => {
            const noClientRouter = new MqttCommandRouter({
                cbusname: 'TestProject',
                ha_discovery_enabled: false,
                internalEventEmitter: mockInternalEmitter,
                cgateCommandQueue: mockQueue,
                settings: { ha_discovery_cover_app_id: '203' }
            });

            noClientRouter.routeMessage('cbus/write/254/203/1/position', '50');
            expect(noClientRouter.coverRampTracker.isRamping('254/203/1')).toBe(false);
            noClientRouter.coverRampTracker.cancelAll();
        });

        it('exposes coverRampTracker getter for external wiring', () => {
            expect(rampRouter.coverRampTracker).toBeDefined();
            expect(typeof rampRouter.coverRampTracker.startRamp).toBe('function');
        });
    });

    describe('temperature broadcast inject', () => {
        it('sends TEMPERATURE BROADCAST with a raw byte of °C × 4', () => {
            router.routeMessage('cbus/write/254/25/3/temperature', '21.5');
            expect(mockQueue.add).toHaveBeenCalledWith('TEMPERATURE BROADCAST //TestProject/254/25/3 86\n');
        });

        it('rejects a temperature outside 0–63.75 °C', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/25/3/temperature', '80');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid temperature'));
            warnSpy.mockRestore();
        });

        it('rejects a temperature command on a non-broadcast application', () => {
            router.routeMessage('cbus/write/254/56/3/temperature', '21.5');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });
    });

    describe('scene module play/record', () => {
        it('ignores play when the feature is off', () => {
            const warnSpy = jest.spyOn(router.logger, 'warn');
            router.routeMessage('cbus/write/254/203/1/play', '4');
            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cbus_scene_module_enabled is off'));
            warnSpy.mockRestore();
        });

        it('sends scene play and record when enabled', () => {
            router.settings.cbus_scene_module_enabled = true;
            router.routeMessage('cbus/write/254/203/1/play', '4');
            expect(mockQueue.add).toHaveBeenCalledWith('scene play 1 4\n');
            mockQueue.add.mockClear();
            router.routeMessage('cbus/write/254/203/1/record', '4');
            expect(mockQueue.add).toHaveBeenCalledWith('scene record 1 4\n');
        });

        it('rejects a scene number outside 0–255', () => {
            router.settings.cbus_scene_module_enabled = true;
            const warnSpy = jest.spyOn(router.logger, 'warn');
            for (const payload of ['256', '-1', 'nope']) {
                mockQueue.add.mockClear();
                router.routeMessage('cbus/write/254/203/1/play', payload);
                expect(mockQueue.add).not.toHaveBeenCalled();
            }
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Scene Module scene'));
            warnSpy.mockRestore();
        });
    });
});
