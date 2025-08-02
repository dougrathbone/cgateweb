const parseString = require('xml2js').parseString;
const { createLogger } = require('./logger');
const { 
    LOG_PREFIX, 
    WARN_PREFIX, 
    ERROR_PREFIX,
    DEFAULT_CBUS_APP_LIGHTING,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
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
    constructor(settings, mqttManager, cgateConnection) {
        this.settings = settings;
        this.mqttManager = mqttManager;
        this.cgateConnection = cgateConnection;
        
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
            this.cgateConnection.send(`${CGATE_CMD_TREEXML} ${networkId}${NEWLINE}`);
        });
    }

    handleTreeStart(statusData) {
        this.logger.info(`Started receiving TreeXML. Network: ${this.treeNetwork || 'unknown'}`);
        this.treeBuffer = '';
    }

    handleTreeData(statusData) {
        this.treeBuffer += statusData + NEWLINE;
    }

    handleTreeEnd(statusData) {
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
                this.logger.error(`Error parsing TreeXML for network ${networkForTree} (took ${duration}ms):`, { error: err });
            } else {
                this.logger.info(`Parsed TreeXML for network ${networkForTree} (took ${duration}ms)`);
                
                // Publish standard tree topic
                this.mqttManager.publish(
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
        
        // Basic validation of the parsed tree data structure
        const networkData = treeData && treeData.Network && treeData.Network.Interface && treeData.Network.Interface.Network;
        if (!networkData || networkData.NetworkNumber !== String(networkId)) {
             this.logger.warn(`TreeXML for network ${networkId} seems malformed or doesn't match expected structure.`);
             return;
        }

        // Ensure units is an array, even if only one unit exists or none
        let units = networkData.Unit || [];
        if (!Array.isArray(units)) {
            units = [units];
        }
        
        const lightingAppId = DEFAULT_CBUS_APP_LIGHTING; 
        const coverAppId = this.settings.ha_discovery_cover_app_id;
        const switchAppId = this.settings.ha_discovery_switch_app_id;
        const relayAppId = this.settings.ha_discovery_relay_app_id;
        const pirAppId = this.settings.ha_discovery_pir_app_id;
        this.discoveryCount = 0;

        // Process each unit for discovery
        units.forEach(unit => {
            if (!unit || !unit.Application) return;

            const applications = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
            
            applications.forEach(app => {
                const appAddress = app.ApplicationAddress;
                
                // Process Lighting Application (56)
                if (appAddress === lightingAppId && app.Group) {
                    this._processLightingGroups(networkId, appAddress, app.Group);
                }
                
                // Process Enable Control Applications (other app IDs)
                else if (app.Group && (
                    (coverAppId && appAddress === coverAppId) ||
                    (switchAppId && appAddress === switchAppId) ||
                    (relayAppId && appAddress === relayAppId) ||
                    (pirAppId && appAddress === pirAppId)
                )) {
                    this._processEnableControlGroups(networkId, appAddress, app.Group);
                }
            });
        });

        const duration = Date.now() - startTime;
        this.logger.info(`HA Discovery completed for network ${networkId}. Published ${this.discoveryCount} entities (took ${duration}ms)`);
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

            this.mqttManager.publish(discoveryTopic, JSON.stringify(payload), { retain: true, qos: 0 });
            this.discoveryCount++;
        });
    }

    _processEnableControlGroups(networkId, appAddress, groups) {
        const groupArray = Array.isArray(groups) ? groups : [groups];
        const coverAppId = this.settings.ha_discovery_cover_app_id;
        const switchAppId = this.settings.ha_discovery_switch_app_id;
        const relayAppId = this.settings.ha_discovery_relay_app_id;
        const pirAppId = this.settings.ha_discovery_pir_app_id;

        groupArray.forEach(group => {
            const groupId = group.GroupAddress;
            if (groupId === undefined || groupId === null || groupId === '') {
                this.logger.warn(`Skipping EnableControl group in HA Discovery due to missing/invalid GroupAddress (App: ${appAddress})`, { group });
                return;
            }

            const groupLabel = group.Label;
            let discovered = false;

            // Check for Cover (highest priority)
            if (coverAppId && appAddress === coverAppId) {
                this._createCoverDiscovery(networkId, appAddress, groupId, groupLabel);
                discovered = true;
            }
            // Check for Switch
            else if (!discovered && switchAppId && appAddress === switchAppId) {
                this._createSwitchDiscovery(networkId, appAddress, groupId, groupLabel);
                discovered = true;
            }
            // Check for Relay
            else if (!discovered && relayAppId && appAddress === relayAppId) {
                this._createRelayDiscovery(networkId, appAddress, groupId, groupLabel);
                discovered = true;
            }
            // Check for PIR
            else if (!discovered && pirAppId && appAddress === pirAppId) {
                this._createPirDiscovery(networkId, appAddress, groupId, groupLabel);
                discovered = true;
            }
        });
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

        this.mqttManager.publish(discoveryTopic, JSON.stringify(payload), { retain: true, qos: 0 });
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

    _createCoverDiscovery(networkId, appId, groupId, groupLabel) {
        this._createDiscovery(networkId, appId, groupId, groupLabel, this._getDiscoveryConfig('cover'));
    }

    _createSwitchDiscovery(networkId, appId, groupId, groupLabel) {
        this._createDiscovery(networkId, appId, groupId, groupLabel, this._getDiscoveryConfig('switch'));
    }

    _createRelayDiscovery(networkId, appId, groupId, groupLabel) {
        this._createDiscovery(networkId, appId, groupId, groupLabel, this._getDiscoveryConfig('relay'));
    }

    _createPirDiscovery(networkId, appId, groupId, groupLabel) {
        this._createDiscovery(networkId, appId, groupId, groupLabel, this._getDiscoveryConfig('pir'));
    }


    // Logging methods that can be overridden
}

module.exports = HaDiscovery;