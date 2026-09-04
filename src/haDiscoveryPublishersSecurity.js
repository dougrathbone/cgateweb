// @ts-check
const { classifySecurityZoneDeviceClass } = require('./deviceTypeClassifier');
const { securityZoneLabelKey } = require('./securityZoneLabels');
const { PANEL_CONDITIONS } = require('./securityPanelConditions');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_ATTRIBUTES,
    MQTT_TOPIC_SUFFIX_LOOP_FAULT,
    MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    HA_COMPONENT_BINARY_SENSOR,
    HA_COMPONENT_ALARM_PANEL,
    HA_COMPONENT_SENSOR,
    HA_COMPONENT_BUTTON,
    HA_DISCOVERY_SUFFIX
} = require('./constants');

/**
 * Static shape for an app-208 security zone binary_sensor. device_class is
 * filled in at publish time from the zone's application-1 label.
 */
const SECURITY_ZONE_ENTITY = {
    component: HA_COMPONENT_BINARY_SENSOR,
    model: 'C-Bus Security Zone',
    fallbackLabel: (networkId, appId, zone) => `CBus Security Zone ${networkId}/${appId}/${zone}`,
    fields: (networkId, appId, zone, deviceClass) => {
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${zone}`;
        return {
            state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            ...(deviceClass && { device_class: deviceClass })
        };
    }
};

class _HaDiscoveryPublishersSecurity {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto HaDiscovery (see the Object.assign in
    // haDiscovery.js), which supplies every member declared below. The field
    // declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {Set<string>} */
    exclude;

    /** @type {Set<string>} */
    _securityZoneSeen;

    /** @type {Set<string>} */
    _securityPanelSeen;

    /**
     * Shared event-driven discovery gate (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => boolean}
     */
    _ensureEventDrivenEntity;

    /**
     * Retract one event-driven discovery config (implemented in haDiscoveryPublishers).
     * @type {(topic: string) => void}
     */
    _retractEventDrivenConfig;

    /**
     * Shared identity preamble (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => { finalLabel: string, uniqueId: string, entityId: string|undefined, area: string|undefined, discoveryTopic: string }}
     */
    _resolveEntityIdentity;

    /**
     * Finish an event-driven discovery entity (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => void}
     */
    _finishEventDrivenEntity;

    /**
     * Event-driven discovery for C-Bus Security (app 208) zones. Called
     * whenever a zone event or status report mentions a zone; announces the
     * HA binary_sensor the first time that zone is seen. Follows the
     * ensureTemperatureDiscovery contract: idempotent Seen set, `exclude`
     * honored with retraction, topics registered in _publishedTopics and
     * _eventDrivenDiscoveryTopics so tree-run stale cleanup skips them.
     *
     * @param {string|number} network
     * @param {string|number} appId - security app id (e.g. 208)
     * @param {string|number} zone  - security zone number (1-127)
     * @returns {boolean} true if a new binary_sensor entity was published this call
     */
    ensureSecurityZoneDiscovery(network, appId, zone) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined || zone === null || zone === undefined) return false;

        const key = `${network}/${appId}/${zone}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._securityZoneSeen,
            // Zone labels live under application 1 in the Toolkit project, so
            // an exclusion can be recorded against either key shape.
            excludeKeys: [key, securityZoneLabelKey(network, zone)],
            describe: `security zone ${key}`,
            retract: () => {
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/cgateweb_${network}_${appId}_${zone}/${HA_DISCOVERY_SUFFIX}`
                );
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/cgateweb_${network}_${appId}_${zone}_loop_fault/${HA_DISCOVERY_SUFFIX}`
                );
            },
            create: () => this._createSecurityZoneDiscovery(String(network), String(appId), String(zone))
        });
    }

    /**
     * Build and publish the binary_sensor discovery payload for one security
     * zone. State comes from the securityEventHandler zone topics
     * (cbus/read/{net}/{app}/{zone}/state ON = unsealed/open/short, OFF =
     * sealed); the raw 2-bit state name rides the JSON attributes topic.
     * The zone's name and device class come from its application-1 label.
     *
     * @private
     */
    _createSecurityZoneDiscovery(networkId, appId, zone) {
        // Zone labels live under application 1 in the Toolkit project (the
        // label importer stores them as {net}/1/{zone} keys).
        const labelKey = securityZoneLabelKey(networkId, zone);
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: zone, labelKey,
            component: SECURITY_ZONE_ENTITY.component,
            fallbackLabel: SECURITY_ZONE_ENTITY.fallbackLabel(networkId, appId, zone)
        });
        const deviceClass = classifySecurityZoneDeviceClass(finalLabel, this.settings);

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: SECURITY_ZONE_ENTITY.component,
            fields: SECURITY_ZONE_ENTITY.fields(networkId, appId, zone, deviceClass),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: SECURITY_ZONE_ENTITY.model,
            area,
            logInfo: `Security zone binary_sensor published: ${networkId}/${appId}/${zone} (${finalLabel})`
        });

        const loopFaultUniqueId = `${uniqueId}_loop_fault`;
        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${loopFaultUniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: loopFaultUniqueId,
            entityId: undefined,
            component: HA_COMPONENT_BINARY_SENSOR,
            name: 'Loop fault',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${zone}/${MQTT_TOPIC_SUFFIX_LOOP_FAULT}`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                device_class: 'problem',
                entity_category: 'diagnostic'
            },
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: SECURITY_ZONE_ENTITY.model,
            area
        });
    }

    /**
     * Announce the seven panel-wide trouble binary_sensors for a network the
     * first time any security traffic is seen on it. Follows the
     * ensureSecurityZoneDiscovery contract: idempotent Seen set, `exclude`
     * honored with retraction, topics registered in _publishedTopics and
     * _eventDrivenDiscoveryTopics so tree-run stale cleanup skips them.
     *
     * Unlike zones (one HA device each), all seven share a single "C-Bus
     * Security Panel" device: they describe the panel's health, not seven
     * separate pieces of hardware. entity_category 'diagnostic' keeps them off
     * auto-generated dashboards.
     *
     * @param {string|number} network
     * @param {string|number} appId - security app id (e.g. 208)
     * @returns {boolean} true if the entities were published this call
     */
    ensureSecurityPanelDiscovery(network, appId) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined) return false;

        const key = `${network}/${appId}/panel`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._securityPanelSeen,
            describe: `security panel ${network}/${appId}`,
            retract: () => {
                for (const condition of PANEL_CONDITIONS) {
                    this._retractEventDrivenConfig(
                        this._securityPanelTopic(this._securityPanelUniqueId(String(network), String(appId), condition.id))
                    );
                }
                this._retractEventDrivenConfig(this._securityAlarmTopic(String(network), String(appId)));
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_password_entry/${HA_DISCOVERY_SUFFIX}`
                );
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_bypassed_zones/${HA_DISCOVERY_SUFFIX}`
                );
            },
            create: () => this._createSecurityPanelDiscovery(String(network), String(appId))
        });
    }

    /**
     * unique_id for one panel trouble condition. The discovery topic embeds this,
     * so both must come from here or a retraction would target a topic HA never
     * saw and orphan the entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @param {string} conditionId
     * @returns {string}
     * @private
     */
    _securityPanelUniqueId(networkId, appId, conditionId) {
        return `cgateweb_${networkId}_${appId}_panel_${conditionId}`;
    }

    /**
     * @param {string} uniqueId
     * @returns {string}
     * @private
     */
    _securityPanelTopic(uniqueId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Discovery config topic for the panel's alarm_control_panel entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @returns {string}
     * @private
     */
    _securityAlarmTopic(networkId, appId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_ALARM_PANEL}/cgateweb_${networkId}_${appId}_panel/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Build and publish the panel trouble binary_sensor payloads, one per
     * condition. State comes from securityEventHandler via
     * cbus/read/{net}/{app}/panel/{condition}/state (ON = trouble present).
     *
     * @private
     */
    _createSecurityPanelDiscovery(networkId, appId) {
        const deviceName = `C-Bus Security Panel ${networkId}/${appId}`;
        const deviceIdentifiers = [`cgateweb_${networkId}_${appId}_panel`];
        for (const condition of PANEL_CONDITIONS) {
            const uniqueId = this._securityPanelUniqueId(networkId, appId, condition.id);
            const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${condition.id}`;

            this._finishEventDrivenEntity({
                discoveryTopic: this._securityPanelTopic(uniqueId),
                uniqueId,
                component: HA_COMPONENT_BINARY_SENSOR,
                // Several entities on one shared device, so each needs its own
                // name (zones use null, taking the device name instead).
                name: condition.name,
                fields: {
                    state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF,
                    device_class: condition.deviceClass,
                    entity_category: 'diagnostic'
                },
                deviceIdentifiers,
                deviceName,
                model: 'C-Bus Security Panel'
            });
        }
        this.logger.info(`Security panel binary_sensors published: ${networkId}/${appId} (${PANEL_CONDITIONS.length} conditions)`);

        this._createSecurityAlarmDiscovery(networkId, appId, deviceName);

        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${networkId}_${appId}_password_entry/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: `cgateweb_${networkId}_${appId}_password_entry`,
            component: HA_COMPONENT_SENSOR,
            name: 'Password entry',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY}`,
                entity_category: 'diagnostic'
            },
            deviceIdentifiers,
            deviceName,
            model: 'C-Bus Security Panel'
        });

        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${networkId}_${appId}_bypassed_zones/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: `cgateweb_${networkId}_${appId}_bypassed_zones`,
            component: HA_COMPONENT_SENSOR,
            name: 'Bypassed zones',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/bypassed_zones/${MQTT_TOPIC_SUFFIX_STATE}`,
                json_attributes_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/bypassed_zones/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                entity_category: 'diagnostic',
                icon: 'mdi:shield-off-outline'
            },
            deviceIdentifiers,
            deviceName,
            model: 'C-Bus Security Panel'
        });
    }

    /**
     * Build and publish the alarm_control_panel entity for the security
     * panel, on the same device as the trouble sensors. State comes from
     * securityEventHandler via cbus/read/{net}/{app}/panel/state (HA alarm
     * states); the arm_not_ready blocking zone rides the attributes topic.
     * Control is opt-in via cbus_security_control_enabled — an arm write
     * carries no PIN on the bus. Read-only cannot mean "no command_topic",
     * though: Home Assistant's MQTT alarm schema requires that key and throws
     * away the whole config without it ("required key not provided @
     * data['command_topic']"), so the entity never appeared at all for the
     * default (control off) install. The topic is therefore always published
     * and read-only is expressed by advertising no arm actions; the router
     * refuses any write that arrives on it while control is off.
     *
     * Home Assistant always renders a Disarm button (supported_features has no
     * disarm flag to withhold). Whether it does anything depends on
     * cbus_security_disarm_enabled, a second opt-in on top of control: C-Bus
     * has no disarm command, so disarming means replaying the PIN through
     * Emulate Keypad (#51), and that is a bigger decision than arming.
     *
     * With disarm on, the panel uses Home Assistant's own keypad via
     * `code: REMOTE_CODE`. That is the variant worth having: HA shows a numeric
     * keypad and passes what was typed straight through to us, so the PIN lives
     * nowhere in configuration — not in the add-on options, not in HA's. The
     * cost is that it crosses MQTT on each disarm, which the docs say plainly.
     *
     * @private
     */
    _createSecurityAlarmDiscovery(networkId, appId, deviceName) {
        const uniqueId = `cgateweb_${networkId}_${appId}_panel`;
        const discoveryTopic = this._securityAlarmTopic(networkId, appId);
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel`;
        const controlEnabled = !!this.settings.cbus_security_control_enabled;
        // Disarm rides on control: the router refuses every panel write while
        // control is off, so there would be nothing for a PIN to reach.
        const disarmEnabled = controlEnabled && !!this.settings.cbus_security_disarm_enabled;
        // Same shape as disarm: a second opt-in riding on control. Withheld
        // from supported_features rather than accepted-and-ignored, so the
        // alarm card never offers a "force arm" the bridge will refuse.
        const bypassEnabled = controlEnabled && !!this.settings.cbus_security_bypass_enabled;

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId,
            component: HA_COMPONENT_ALARM_PANEL,
            // Primary entity on the shared panel device: takes the device name.
            fields: {
                state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
                json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                // Arm away/night/home(day-stay)/vacation, plus arm_custom_bypass.
                // No manual trigger on this panel, and disarm is not in this list
                // because HA has no such flag — see the note above.
                //
                // arm_custom_bypass is mapped to the '#' keypress that forces an
                // arm past an open zone. That is not quite HA's literal meaning
                // (arm while excluding chosen zones), but it is the closest native
                // action and it is what the panel actually offers, so the bypass
                // appears on the alarm card itself instead of only as a separate
                // button entity (#62). Present only with cbus_security_bypass_enabled.
                //
                // Empty with control off: that is how a read-only panel is
                // expressed now that the command topic has to be present
                // regardless, so the card shows state without offering an arm
                // the bridge would refuse.
                supported_features: controlEnabled
                    ? [
                        'arm_home', 'arm_away', 'arm_night', 'arm_vacation',
                        ...(bypassEnabled ? ['arm_custom_bypass'] : [])
                    ]
                    : [],
                // Home Assistant defaults both of these to true and then refuses to
                // publish an arm/disarm without a code — it pops "PIN required" and
                // the command never reaches MQTT at all, which is how 1.23.1 shipped
                // an arm button that did nothing (#42). Arming carries no PIN on
                // C-Bus, so there is never a code to enter for it.
                code_arm_required: false,
                code_disarm_required: disarmEnabled,
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/arm`,
                ...(disarmEnabled && {
                    // REMOTE_CODE: show HA's numeric keypad but skip HA's local
                    // validation, since only the panel can judge the PIN. A literal
                    // code here would be a second PIN to keep in sync and would
                    // block the real one from ever reaching the panel.
                    code: 'REMOTE_CODE',
                    // tojson rather than hand-quoting: a code is user input, and an
                    // embedded quote would otherwise produce malformed JSON. Arm
                    // actions come through here too with an empty code.
                    command_template:
                        '{"action": {{ action | tojson }}, "code": {{ (code or "") | tojson }}}'
                })
            },
            deviceIdentifiers: [uniqueId],
            deviceName,
            model: 'C-Bus Security Panel'
        });
        const mode = !controlEnabled
            ? 'read-only'
            : [disarmEnabled ? 'arm + disarm' : 'arm only', bypassEnabled ? '+ bypass' : ''].filter(Boolean).join(' ');
        this.logger.info(`Security panel alarm_control_panel published: ${networkId}/${appId} (${mode})`);

        // The bypass button is a control write (Emulate Keypad '#') behind its
        // own opt-in, so it only exists when both are on — otherwise it would
        // be a button that always logs "disabled" and does nothing.
        if (bypassEnabled) {
            this._createSecurityBypassDiscovery(networkId, appId, deviceName);
        }
    }

    /**
     * Build and publish the "Bypass open zones" button on the security panel
     * device. Pressing it sends the '#' keypress via `security emulate_keypad`,
     * which is what the physical keypad uses to bypass open zones when arming
     * stalls at arm_not_ready (issue #42).
     *
     * @private
     */
    _createSecurityBypassDiscovery(networkId, appId, deviceName) {
        const uniqueId = `cgateweb_${networkId}_${appId}_panel_bypass`;
        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BUTTON}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId,
            component: HA_COMPONENT_BUTTON,
            name: 'Bypass open zones',
            fields: {
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/bypass`
            },
            deviceIdentifiers: [`cgateweb_${networkId}_${appId}_panel`],
            deviceName,
            model: 'C-Bus Security Panel',
            logInfo: `Security panel zone-bypass button published: ${networkId}/${appId}`
        });
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishersSecurity.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishersSecurity.prototype[name];
}
module.exports = methods;
