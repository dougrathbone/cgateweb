// @ts-check
const { resolveSetting } = require('./config/schema');
const { NEWLINE } = require('./constants');
const { buildSecurityArmCommand, buildSecurityEmulateKeypadCommand } = require('./securityCommand');
const RateLimiter = require('./web/rateLimiter');

// Upper bound on PIN length before we start typing at the panel. Alarm PINs are
// 4-8 digits in practice; this is a sanity guard so a malformed payload cannot
// queue hundreds of keypresses, not a protocol limit.
const SECURITY_MAX_PIN_DIGITS = 16;

// Key that submits a typed code at the panel. Confirmed on real hardware in
// #51: without it the panel just holds the digits, and ENTER ($0D) does
// nothing. `#` is also the key that forces an arm past open zones, so the panel
// treats it as the general accept.
const SECURITY_KEYPAD_ACCEPT = '#';

// HA MQTT alarm command payloads → C-Gate arm-mode keyword.
//
// These are the words C-Gate's command interface expects, not the numeric
// values the application spec defines. C-Gate manual §4.5.177:
//
//     SECURITY ARM app arm-mode
//     arm-mode = "away" | "night" (home) | "day" | "vacation" | "highest"
//
// 1.23.0 and 1.23.1 sent the spec's bus-level numbers ($01..$04) here and every
// arm was rejected with `405 Parameter out of range (bad arm mode)`, so arming
// has never worked. The numbers were not wrong for the bus, just never right
// for the interface we actually write to — read the C-Gate manual for command
// syntax and the application spec only for what travels on the bus (#42).
//
// Arming only. There is deliberately no DISARM entry: C-Gate offers no disarm
// arm-mode, and the spec reserves $00 rather than defining it as disarm.
// Disarming needs SECURITY EMULATE_KEYPAD, replaying the PIN keypress by
// keypress — tracked separately in #51.
const SECURITY_ARM_MODE_BY_PAYLOAD = {
    ARM_AWAY: 'away',
    ARM_NIGHT: 'night',
    ARM_HOME: 'day',
    ARM_VACATION: 'vacation'
};

class _MqttCommandRouterSecurity {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto MqttCommandRouter (see the Object.assign
    // in mqttCommandRouter.js), which supplies every member declared below. The
    // field declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {string} */
    cbusname;

    /** @type {RateLimiter|null} */
    _disarmLimiter;

    /**
     * Queue a C-Gate command string (implemented on MqttCommandRouter).
     * @type {(command: string, priority?: *) => void}
     */
    _queueCommand;

    /**
     * Sliding-window limiter for disarm attempts. Shares the web API's
     * implementation rather than repeating the window logic - see
     * RateLimiter for why the eviction order there is worth having once.
     *
     * The tracked-key cap matters here too: an attacker can address any
     * network/application pair, so without it the map would grow with each one
     * tried. The pairs are already bounded by CBusEvent's range check on the
     * read side and by the topic regex here, but the cap makes it explicit.
     *
     * @returns {RateLimiter}
     * @private
     */
    _getDisarmLimiter() {
        const maxRequests = resolveSetting(this.settings, 'securityDisarmMaxAttempts');
        const windowMs = resolveSetting(this.settings, 'securityDisarmAttemptWindowMs');
        const maxTrackedSources = resolveSetting(this.settings, 'securityDisarmMaxTrackedKeys');
        if (!this._disarmLimiter
            || this._disarmLimiter.maxRequests !== maxRequests
            || this._disarmLimiter.windowMs !== windowMs
            || this._disarmLimiter.maxTrackedSources !== maxTrackedSources) {
            this._disarmLimiter = new RateLimiter({
                windowMs,
                maxRequests,
                maxTrackedSources
            });
        }
        return this._disarmLimiter;
    }

    /**
     * Handles security panel arm/disarm (cbus/write/{net}/{app}/panel/arm).
     * Gated on cbus_security_control_enabled; disarm additionally on
     * cbus_security_disarm_enabled. The panel confirms with a system_arm (or
     * arm_not_ready) broadcast, which drives the state machine — no optimistic
     * state is published here.
     *
     * Nothing in here may log the payload. With the keypad enabled it carries
     * the alarm PIN, so only the parsed action and a digit count are ever
     * logged — see _parseSecurityCommand.
     *
     * @param {string} network - Network id from the topic.
     * @param {string} application - Application id from the topic.
     * @param {string} payload - Bare action, or the JSON the command_template emits.
     * @param {string} topic - Original topic for logging.
     * @private
     */
    _handleSecurityArm(network, application, payload, topic) {
        if (!this.settings.cbus_security_control_enabled) {
            this.logger.warn(`Security panel control is disabled (set cbus_security_control_enabled to enable); ignoring command on ${topic}`);
            return;
        }
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0' || String(application) !== String(appId)) {
            this.logger.warn(`Security command for unconfigured application ${application} on topic ${topic}`);
            return;
        }

        const { action, code } = this._parseSecurityCommand(payload);

        if (action === 'DISARM') {
            this._handleSecurityDisarm(network, application, code, topic);
            return;
        }

        if (action === 'ARM_CUSTOM_BYPASS') {
            // Home Assistant's own alarm-panel action for "arm, bypassing what
            // is in the way". On this panel that is exactly the '#' keypress,
            // so it routes to the same place as the bypass button rather than
            // being a second implementation. Reported on #62 by the user who
            // was already driving it this way from his own project.
            this._sendBypassKeypress(network, application, topic);
            return;
        }

        const mode = SECURITY_ARM_MODE_BY_PAYLOAD[action];
        if (mode === undefined) {
            // Deliberately quotes the action, never the payload: the payload may
            // be JSON carrying a PIN.
            this.logger.warn(`Unknown security command "${action}" on topic ${topic} (expected DISARM|ARM_AWAY|ARM_NIGHT|ARM_HOME|ARM_VACATION)`);
            return;
        }

        const cmd = buildSecurityArmCommand({ cbusname: this.cbusname, network, application, mode });
        this._queueCommand(cmd + NEWLINE);
        this.logger.info(`Security arm: ${network}/${application} -> ${mode} (${action})`);
    }

    /**
     * Handles the zone-bypass button (cbus/write/{net}/{app}/panel/bypass).
     * Sends the '#' keypress through `security emulate_keypad`, which is what
     * the physical keypad uses to bypass open zones when arming stalls at
     * arm_not_ready (#42). Gated on cbus_security_control_enabled like every
     * other panel write, and additionally on cbus_security_bypass_enabled.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} topic - For log context only.
     * @private
     */
    _handleSecurityBypass(network, application, topic) {
        if (!this.settings.cbus_security_control_enabled) {
            this.logger.warn(`Security panel control is disabled (set cbus_security_control_enabled to enable); ignoring command on ${topic}`);
            return;
        }
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0' || String(application) !== String(appId)) {
            this.logger.warn(`Security command for unconfigured application ${application} on topic ${topic}`);
            return;
        }

        this._sendBypassKeypress(network, application, topic);
    }

    /**
     * Send the '#' keypress that forces an arm past open zones.
     *
     * Shared by the two ways a user can reach it: the dedicated bypass button
     * on its own topic, and Home Assistant's `arm_custom_bypass` action on the
     * alarm panel itself (#62). Both end up here so the two cannot drift.
     *
     * The cbus_security_bypass_enabled check lives HERE rather than in the two
     * callers, deliberately. Forcing an arm past an open zone is a different
     * promise from arming - the alarm reports armed while that door is not
     * actually covered - so it gets its own opt-in on top of control. Putting
     * the check at the single point both routes funnel through means a future
     * third caller cannot miss it, which is exactly how the first cut of this
     * feature ended up ungated: the HA arm_custom_bypass action was added as a
     * second entry point and inherited only the arm gate.
     *
     * Callers remain responsible for the control-enabled and application checks
     * - both entry points already do them for their own error messages.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} topic - For log context only.
     * @returns {boolean} false if bypass is disabled and nothing was sent.
     * @private
     */
    _sendBypassKeypress(network, application, topic) {
        if (!this.settings.cbus_security_bypass_enabled) {
            this.logger.warn(`Security zone bypass is disabled (set cbus_security_bypass_enabled to allow arming past open zones); ignoring command on ${topic}`);
            return false;
        }
        const cmd = buildSecurityEmulateKeypadCommand({
            cbusname: this.cbusname, network, application, key: SECURITY_KEYPAD_ACCEPT.charCodeAt(0)
        });
        this._queueCommand(cmd + NEWLINE);
        this.logger.info(`Security zone bypass keypress (#) sent: ${network}/${application}`);
        return true;
    }

    /**
     * Split a panel command payload into its action and code.
     *
     * Two shapes reach this topic. With the keypad enabled, Home Assistant's
     * command_template emits `{"action": "DISARM", "code": "1234"}`. Without it
     * — and from any hand-rolled panel or script — the payload is the bare
     * action, `ARM_AWAY`. Both are accepted so enabling disarm does not break
     * anyone's existing automations.
     *
     * A payload that starts with `{` but does not parse is treated as an empty
     * action rather than being echoed anywhere, on the assumption that a
     * malformed template still contained a code.
     *
     * @param {string} payload
     * @returns {{action: string, code: string}}
     * @private
     */
    _parseSecurityCommand(payload) {
        const raw = String(payload === null || payload === undefined ? '' : payload).trim();
        if (!raw.startsWith('{')) {
            return { action: raw.toUpperCase(), code: '' };
        }
        try {
            const parsed = JSON.parse(raw);
            const field = (value) => String(value === null || value === undefined ? '' : value).trim();
            return {
                action: field(parsed && parsed.action).toUpperCase(),
                code: field(parsed && parsed.code)
            };
        } catch {
            this.logger.warn('Security command payload looked like JSON but could not be parsed; ignoring it (payload withheld — it may contain a PIN)');
            return { action: '', code: '' };
        }
    }

    /**
     * Disarm by replaying the PIN through `security emulate_keypad`, one
     * keypress per digit, exactly as if typed on the panel's own keypad
     * (C-Gate manual §4.5.179, issue #51).
     *
     * C-Bus has no disarm command, so this is the only route. The panel decides
     * whether the PIN is right — cgateweb never sees a success or failure
     * beyond the panel's subsequent broadcast, and deliberately does not guess.
     *
     * @param {string} network
     * @param {string} application
     * @param {string} code - Digits typed on Home Assistant's keypad.
     * @param {string} topic
     * @private
     */
    _handleSecurityDisarm(network, application, code, topic) {
        if (!this.settings.cbus_security_disarm_enabled) {
            this.logger.warn(`Security disarm is disabled (set cbus_security_disarm_enabled to enable); ignoring disarm on ${topic}`);
            return;
        }
        if (!code) {
            this.logger.warn(`Security disarm on ${topic} carried no PIN; the panel cannot be disarmed without one. If Home Assistant did not prompt for a code, re-run discovery so the panel picks up the keypad configuration.`);
            return;
        }
        // Digits only. The keypad emulation can send any ASCII character, so
        // without this a stray payload could type arbitrary keys at the panel.
        if (!/^[0-9]+$/.test(code)) {
            this.logger.warn(`Security disarm on ${topic} rejected: PIN must be digits only (value withheld)`);
            return;
        }
        if (code.length > SECURITY_MAX_PIN_DIGITS) {
            this.logger.warn(`Security disarm on ${topic} rejected: PIN longer than ${SECURITY_MAX_PIN_DIGITS} digits`);
            return;
        }
        // Counted last, so a malformed payload cannot burn a real user's
        // allowance - only a well-formed guess costs an attempt.
        //
        // Every attempt counts, right PIN or wrong: cgateweb cannot tell them
        // apart, since only the panel judges the code and it answers with a
        // broadcast rather than a reply. Guessing that from the state machine
        // would mean the limiter could be reset by anything that looked like a
        // disarm, which is the wrong way for that to fail.
        if (this._getDisarmLimiter().isLimitedByKey(`${network}/${application}`)) {
            this.logger.warn(`Security disarm on ${topic} rejected: too many disarm attempts for ${network}/${application}; refusing further PIN entry for now. If this was not you, someone is guessing your alarm code over MQTT.`);
            return;
        }

        // The digits, then the accept key. Without the terminator the panel
        // holds the digits and waits, so 1.24.0's disarm looked like it did
        // nothing at all (#51). ENTER was tried on real hardware first and had
        // no effect; `#` is what actually submits the code.
        const keys = [...code, SECURITY_KEYPAD_ACCEPT];
        for (const character of keys) {
            const cmd = buildSecurityEmulateKeypadCommand({
                cbusname: this.cbusname,
                network,
                application,
                // The command takes the ASCII code of the key, not the character.
                key: character.charCodeAt(0)
            });
            this._queueCommand(cmd + NEWLINE);
        }
        // Digit count, never the digits. Enough to confirm the keypresses went
        // out and to spot a truncated PIN, without putting it in the log.
        this.logger.info(`Security disarm: ${network}/${application} -> sent ${code.length} digits + accept key`);
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_MqttCommandRouterSecurity.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _MqttCommandRouterSecurity.prototype[name];
}
module.exports = methods;
