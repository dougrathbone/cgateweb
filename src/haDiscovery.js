const parseString = require('xml2js').parseString;
const { createLogger } = require('./logger');
const {
    DEFAULT_CBUS_APP_LIGHTING,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_STOP,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_COVER,
    HA_COMPONENT_SWITCH,
    HA_DISCOVERY_SUFFIX,
    HA_DEVICE_CLASS_SHUTTER,
    HA_DEVICE_CLASS_OUTLET,
    HA_DEVICE_VIA,
    HA_DEVICE_MANUFACTURER,
    HA_MODEL_LIGHTING,
    HA_MODEL_COVER,
    HA_MODEL_SWITCH,
    HA_MODEL_RELAY,
    HA_MODEL_PIR,
    HA_ORIGIN_NAME,
    HA_ORIGIN_SW_VERSION,
    HA_ORIGIN_SUPPORT_URL,
    CGATE_CMD_TREEXML,
    NEWLINE
} = require('./constants');

class HaDiscovery {
    /**
     * @param {Object} settings - Configuration settings
     * @param {Function} publishFn - Function to publish MQTT messages: (topic, payload, options) => void
     * @param {Function} sendCommandFn - Function to send C-Gate commands: (command) => void
     */
    constructor(settings, publishFn, sendCommandFn) {
        this.settings = settings;
        this._publish = publishFn;
        this._sendCommand = sendCommandFn;
        
        this.treeBuffer = '';
        this.treeNetwork = null;
        this.discoveryCount = 0;
        this.logger = createLogger({ component: 'HaDiscovery' });
    }

    trigger() {
        if (!this.settings.ha_discovery_enabled) {
            return;
        }

        this.logger.info(`HA Discovery enabled, querying network trees...`);
        let networksToDiscover = this.settings.ha_discovery_networks;
        
        // If specific networks aren't configured, attempt to use the network 
        // from the getallnetapp setting (if specified).
        if (networksToDiscover.length === 0 && this.settings.getallnetapp) {
            const networkIdMatch = String(this.settings.getallnetapp).match(/^(\d+)/);
            if (networkIdMatch) {
                this.logger.info(`No HA discovery networks configured, using network from getallnetapp: ${networkIdMatch[1]}`);
                networksToDiscover = [networkIdMatch[1]];
            } else {
                this.logger.warn(`No HA discovery networks configured and could not determine network from getallnetapp (${this.settings.getallnetapp}). HA Discovery will not run.`);
                return;
            }
        } else if (networksToDiscover.length === 0) {
             this.logger.warn(`No HA discovery networks configured. HA Discovery will not run.`);
             return;
        }

        // Request TreeXML for each configured network
        networksToDiscover.forEach(networkId => {
            this.logger.info(`Requesting TreeXML for network ${networkId}...`);
            this.treeNetwork = networkId;
            this._sendCommand(`${CGATE_CMD_TREEXML} ${networkId}${NEWLINE}`);
        });
    }

    handleTreeStart(_statusData) {
        this.logger.info(`Started receiving TreeXML. Network: ${this.treeNetwork || 'unknown'}`);
        this.treeBuffer = '';
    }

    handleTreeData(statusData) {
        this.treeBuffer += statusData + NEWLINE;
    }

    handleTreeEnd(_statusData) {
        this.logger.info(`Finished receiving TreeXML. Network: ${this.treeNetwork || 'unknown'}. Size: ${this.treeBuffer.length} bytes. Parsing...`);
        const networkForTree = this.treeNetwork;
        const treeXmlData = this.treeBuffer;
        
        // Clear buffer and network context immediately
        this.treeBuffer = ''; 
        this.treeNetwork = null; 

        if (!networkForTree || !treeXmlData) {
             this.logger.warn(`Received TreeXML end (344) but no buffer or network context was set.`); 
             return;
        }

        // Log before parsing
        this.logger.info(`Starting XML parsing for network ${networkForTree}...`);
        const startTime = Date.now();

        parseString(treeXmlData, { explicitArray: false }, (err, result) => { 
            const duration = Date.now() - startTime;
            if (err) {
                this.logger.error(`Error parsing TreeXML for network ${networkForTree} (took ${duration}ms): ${err.message || err}`);
            } else {
                this.logger.info(`Parsed TreeXML for network ${networkForTree} (took ${duration}ms)`);
                
                // Publish standard tree topic
                this._publish(
                    `${MQTT_TOPIC_PREFIX_READ}/${networkForTree}///tree`,
                    JSON.stringify(result),
                    { retain: true, qos: 0 }
                );
                
                // Generate HA Discovery messages
                this._publishDiscoveryFromTree(networkForTree, result);
            }
        });
    }

    _publishDiscoveryFromTree(networkId, treeData) {
        this.logger.info(`Generating HA Discovery messages for network ${networkId}...`);
        const startTime = Date.now();
        
        const networkData = this._findNetworkData(networkId, treeData);
        if (!networkData) {
             this.logger.warn(`TreeXML for network ${networkId}: could not find network data. Top-level keys: ${JSON.stringify(Object.keys(treeData || {}))}`);
             return;
        }

        let units = networkData.Unit || [];
        if (!Array.isArray(units)) {
            units = [units];
        }
        
        const lightingAppId = DEFAULT_CBUS_APP_LIGHTING; 
        const coverAppId = this.settings.ha_discovery_cover_app_id;
        const switchAppId = this.settings.ha_discovery_switch_app_id;
        const relayAppId = this.settings.ha_discovery_relay_app_id;
        const pirAppId = this.settings.ha_discovery_pir_app_id;
        const targetApps = [lightingAppId, coverAppId, switchAppId, relayAppId, pirAppId].filter(Boolean).map(String);
        this.discoveryCount = 0;

        // C-Gate TREEXML returns two formats depending on version/path:
        //   Structured: unit.Application = [{ ApplicationAddress, Group: [{GroupAddress, Label}] }]
        //   Flat:       unit.Application = "56, 255", unit.Groups = "103,104,105"
        // groupsByApp maps appId -> Map<groupId, groupObject>
        const groupsByApp = new Map();

        units.forEach(unit => {
            if (!unit) return;
            this._collectUnitGroups(unit, groupsByApp, targetApps);
        });

        for (const [appId, groupMap] of groupsByApp) {
            const groups = Array.from(groupMap.values());
            if (String(appId) === String(lightingAppId)) {
                this._processLightingGroups(networkId, appId, groups);
            } else {
                this._processEnableControlGroups(networkId, appId, groups);
            }
        }

        const duration = Date.now() - startTime;
        this.logger.info(`HA Discovery completed for network ${networkId}. Published ${this.discoveryCount} entities (took ${duration}ms)`);
    }

    /**
     * Collect groups from a unit into groupsByApp, handling both structured and flat formats.
     * Structured format preserves per-app group mapping and labels.
     * Flat format assigns all groups to every matching target app.
     */
    _collectUnitGroups(unit, groupsByApp, targetApps) {
        if (!unit.Application) return;

        // Structured format: Application is an object or array of objects with Group sub-arrays
        if (typeof unit.Application === 'object') {
            const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
            apps.forEach(app => {
                const appId = app.ApplicationAddress != null ? String(app.ApplicationAddress) : undefined;
                if (!appId || !targetApps.includes(appId) || !app.Group) return;
                const groups = Array.isArray(app.Group) ? app.Group : [app.Group];
                if (!groupsByApp.has(appId)) groupsByApp.set(appId, new Map());
                const groupMap = groupsByApp.get(appId);
                groups.forEach(g => {
                    if (g.GroupAddress != null && !groupMap.has(String(g.GroupAddress))) {
                        groupMap.set(String(g.GroupAddress), g);
                    }
                });
            });
            return;
        }

        // Flat format: Application is a comma-separated string, Groups is a comma-separated string
        const unitAppIds = String(unit.Application).split(',').map(s => s.trim()).filter(Boolean);
        const groupIds = (unit.Groups && typeof unit.Groups === 'string')
            ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        if (groupIds.length === 0) return;

        const matchingApps = targetApps.filter(t => unitAppIds.includes(t));
        matchingApps.forEach(appId => {
            if (!groupsByApp.has(appId)) groupsByApp.set(appId, new Map());
            const groupMap = groupsByApp.get(appId);
            groupIds.forEach(gid => {
                if (!groupMap.has(gid)) {
                    groupMap.set(gid, { GroupAddress: gid });
                }
            });
        });
    }

    /**
     * Locate the Network node within parsed TreeXML, handling different
     * XML structures that C-Gate versions may produce.
     */
    _findNetworkData(networkId, treeData) {
        if (!treeData) return null;
        const idStr = String(networkId);

        // Path 1: <Network><Interface><Network NetworkNumber="254">
        const viaInterface = treeData.Network && treeData.Network.Interface && treeData.Network.Interface.Network;
        if (viaInterface && String(viaInterface.NetworkNumber) === idStr) return viaInterface;

        // Path 2: single <Network> wrapper with matching NetworkNumber
        if (treeData.Network && String(treeData.Network.NetworkNumber) === idStr) return treeData.Network;

        // Path 3: top-level has NetworkNumber directly (flat parse)
        if (String(treeData.NetworkNumber) === idStr) return treeData;

        // Path 4: <Network> with Unit children but no NetworkNumber attribute.
        // C-Gate's TREEXML for a specific network omits NetworkNumber.
        if (treeData.Network && treeData.Network.Unit) return treeData.Network;

        // Path 5: wrapped in a container element -- walk one level
        for (const key of Object.keys(treeData)) {
            const child = treeData[key];
            if (child && typeof child === 'object') {
                if (String(child.NetworkNumber) === idStr) return child;
                if (child.Network && String(child.Network.NetworkNumber) === idStr) return child.Network;
                if (child.Interface && child.Interface.Network && String(child.Interface.Network.NetworkNumber) === idStr) {
                    return child.Interface.Network;
                }
                if (child.Unit) return child;
            }
        }

        return null;
    }

    _processLightingGroups(networkId, appId, groups) {
        const groupArray = Array.isArray(groups) ? groups : [groups];
        
        groupArray.forEach(group => {
            const groupId = group.GroupAddress;
            if (groupId === undefined || groupId === null || groupId === '') {
                this.logger.warn(`Skipping lighting group in HA Discovery due to missing/invalid GroupAddress`, { group });
                return;
            }

            const groupLabel = group.Label;
            const finalLabel = groupLabel || `CBus Light ${networkId}/${appId}/${groupId}`;
            const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
            const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

            const payload = { 
                name: finalLabel,
                unique_id: uniqueId,
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_RAMP}`,
                brightness_state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
                brightness_command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_RAMP}`,
                brightness_scale: 100,
                on_command_type: 'brightness',
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                state_value_template: '{{ value }}',
                brightness_value_template: '{{ value }}',
                qos: 0,
                retain: true,
                device: { 
                    identifiers: [uniqueId],
                    name: finalLabel,
                    manufacturer: HA_DEVICE_MANUFACTURER,
                    model: HA_MODEL_LIGHTING,
                    via_device: HA_DEVICE_VIA
                },
                origin: { 
                    name: HA_ORIGIN_NAME,
                    sw_version: HA_ORIGIN_SW_VERSION,
                    support_url: HA_ORIGIN_SUPPORT_URL
                }
            };

            this._publish(discoveryTopic, JSON.stringify(payload), { retain: true, qos: 0 });
            this.discoveryCount++;
        });
    }

    _processEnableControlGroups(networkId, appAddress, groups) {
        const groupArray = Array.isArray(groups) ? groups : [groups];
        
        // Determine the discovery type based on application address
        const discoveryType = this._getDiscoveryTypeForApp(appAddress);
        if (!discoveryType) {
            return;
        }

        groupArray.forEach(group => {
            const groupId = group.GroupAddress;
            if (groupId === undefined || groupId === null || groupId === '') {
                this.logger.warn(`Skipping EnableControl group in HA Discovery due to missing/invalid GroupAddress (App: ${appAddress})`, { group });
                return;
            }

            this._createDiscovery(networkId, appAddress, groupId, group.Label, this._getDiscoveryConfig(discoveryType));
        });
    }

    /**
     * Determines the discovery type for a given application address.
     * @param {string} appAddress - The application address
     * @returns {string|null} The discovery type ('cover', 'switch', 'relay', 'pir') or null if not configured
     * @private
     */
    _getDiscoveryTypeForApp(appAddress) {
        const appStr = String(appAddress);
        if (this.settings.ha_discovery_cover_app_id && appStr === String(this.settings.ha_discovery_cover_app_id)) {
            return 'cover';
        }
        if (this.settings.ha_discovery_switch_app_id && appStr === String(this.settings.ha_discovery_switch_app_id)) {
            return 'switch';
        }
        if (this.settings.ha_discovery_relay_app_id && appStr === String(this.settings.ha_discovery_relay_app_id)) {
            return 'relay';
        }
        if (this.settings.ha_discovery_pir_app_id && appStr === String(this.settings.ha_discovery_pir_app_id)) {
            return 'pir';
        }
        return null;
    }

    // Unified discovery creation method to eliminate code duplication
    _createDiscovery(networkId, appId, groupId, groupLabel, config) {
        const finalLabel = groupLabel || `CBus ${config.defaultType} ${networkId}/${appId}/${groupId}`;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${config.component}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
        
        const payload = { 
            name: finalLabel,
            unique_id: uniqueId,
            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
            ...(!config.omitCommandTopic && { command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}` }),
            ...config.payloads,
            // Add position topics for covers
            ...(config.positionSupport && {
                position_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_POSITION}`,
                set_position_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_POSITION}`,
                stop_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_STOP}`,
                payload_stop: MQTT_COMMAND_STOP,
                position_open: 100,
                position_closed: 0
            }),
            qos: 0,
            retain: true,
            ...(config.deviceClass && { device_class: config.deviceClass }),
            device: { 
                identifiers: [uniqueId],
                name: finalLabel,
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: config.model,
                via_device: HA_DEVICE_VIA
            },
            origin: { 
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
        };

        this._publish(discoveryTopic, JSON.stringify(payload), { retain: true, qos: 0 });
        this.discoveryCount++;
    }

    // Configuration objects for different discovery types
    _getDiscoveryConfig(type) {
        const configs = {
            cover: {
                component: HA_COMPONENT_COVER,
                defaultType: 'Cover',
                model: HA_MODEL_COVER,
                deviceClass: HA_DEVICE_CLASS_SHUTTER,
                // Enable position support for covers (0-100%)
                positionSupport: true,
                payloads: {
                    payload_open: MQTT_STATE_ON,
                    payload_close: MQTT_STATE_OFF,
                    state_open: MQTT_STATE_ON,
                    state_closed: MQTT_STATE_OFF
                }
            },
            switch: {
                component: HA_COMPONENT_SWITCH,
                defaultType: 'Switch',
                model: HA_MODEL_SWITCH,
                payloads: {
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF,
                    state_on: MQTT_STATE_ON,
                    state_off: MQTT_STATE_OFF
                }
            },
            relay: {
                component: HA_COMPONENT_SWITCH,
                defaultType: 'Relay',
                model: HA_MODEL_RELAY,
                deviceClass: HA_DEVICE_CLASS_OUTLET,
                payloads: {
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF,
                    state_on: MQTT_STATE_ON,
                    state_off: MQTT_STATE_OFF
                }
            },
            pir: {
                component: 'binary_sensor',
                defaultType: 'PIR',
                model: HA_MODEL_PIR,
                deviceClass: 'motion',
                payloads: {
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF
                },
                // PIR sensors don't have command topics - they're read-only
                omitCommandTopic: true
            }
        };
        return configs[type];
    }
}

module.exports = HaDiscovery;