'use strict';

const HaDiscovery = require('../../src/haDiscovery');

/**
 * Shared fixtures and helpers for Home Assistant discovery tests.
 * Keeps MOCK_TREEXML / makeDiscovery / payload lookup in one place so
 * haDiscovery.test.js and the per-application *Discovery.test.js files
 * do not each reinvent the same three-line publish-call finder.
 */

/** Nested C-Gate tree for network 254 with lighting (56) and cover (203) groups. */
const MOCK_TREEXML_RESULT_NET254 = {
    Network: {
        Interface: {
            Network: {
                NetworkNumber: '254',
                Unit: [
                    {
                        UnitAddress: '100',
                        Application: [
                            {
                                ApplicationAddress: '56',
                                Group: [
                                    { GroupAddress: '10', Label: 'Kitchen Light' },
                                    { GroupAddress: '11', Label: 'Living Room' },
                                    { GroupAddress: '12', Label: 'Bedroom Light' }
                                ]
                            },
                            {
                                ApplicationAddress: '203',
                                Group: [
                                    { GroupAddress: '15', Label: 'Blind 1' },
                                    { GroupAddress: '16', Label: 'Blind 2' },
                                    { GroupAddress: '17', Label: 'Garage Door' },
                                    { GroupAddress: '20', Label: 'Relay Switch' }
                                ]
                            }
                        ]
                    }
                ]
            }
        }
    }
};

// Valid C-Gate TreeXML for network 254 with one App 56 lighting group. Used by
// tests that need handleTreeEnd's real xml2js parse to yield findable network
// data (haDiscovery captures parseString at require time, so jest.spyOn on
// xml2js.parseString does not take effect — the real parser runs).
const TREEXML_NET254 =
    '<Network><NetworkNumber>254</NetworkNumber>' +
    '<Unit><UnitAddress>100</UnitAddress>' +
    '<Application><ApplicationAddress>56</ApplicationAddress>' +
    '<Group><GroupAddress>10</GroupAddress><Label>Kitchen Light</Label></Group>' +
    '</Application></Unit></Network>';

/**
 * Flat-format tree for network 254 with the two units from the issue #25
 * sample, parameterised by the group bindings each reports.
 *
 * @param {string} unit13Groups
 * @param {string} [unit14Groups='']
 * @returns {string}
 */
const flatTreeNet254 = (unit13Groups, unit14Groups = '') =>
    '<Network><NetworkNumber>254</NetworkNumber>' +
    `<Unit><Type>RELDN12</Type><Address>13</Address><Application>56, 255</Application><Groups>${unit13Groups}</Groups></Unit>` +
    `<Unit><Type>RELAY2</Type><Address>14</Address><Application>56, 255</Application><Groups>${unit14Groups}</Groups></Unit>` +
    '</Network>';

/** Mid-sync: unit 14 has not reported its groups yet. */
const PARTIAL_GROUPS_TREE_NET254 = flatTreeNet254('31,32');
/** What C-Gate returns for the same network once the sync has finished. */
const FULL_GROUPS_TREE_NET254 = flatTreeNet254('31,32', '115');

const DEFAULT_DISCOVERY_SETTINGS = {
    ha_discovery_enabled: true,
    ha_discovery_prefix: 'testhomeassistant',
    ha_discovery_networks: ['254']
};

/**
 * Build a HaDiscovery instance with a jest publish spy.
 * @param {Object} [settings]
 * @param {Object|null} [labelData]
 * @returns {{ d: import('../../src/haDiscovery'), publish: jest.Mock }}
 */
function makeDiscovery(settings = {}, labelData = null) {
    const publish = jest.fn();
    const d = new HaDiscovery(
        { ...DEFAULT_DISCOVERY_SETTINGS, ...settings },
        publish,
        jest.fn(),
        labelData
    );
    return { d, publish };
}

/**
 * First MQTT publish call for an exact discovery config topic, or undefined.
 * @param {jest.Mock} publishFn
 * @param {string} topic
 * @returns {[string, string, Object]|undefined}
 */
function findDiscoveryCall(publishFn, topic) {
    return publishFn.mock.calls.find(c => c[0] === topic);
}

/**
 * Parsed discovery payload for a topic, or null if nothing was published
 * (or the retained clear-empty string was published).
 * @param {jest.Mock} publishFn
 * @param {string} topic
 * @returns {Object|null}
 */
function findDiscoveryPayload(publishFn, topic) {
    const call = findDiscoveryCall(publishFn, topic);
    if (!call || !call[1]) return null;
    return JSON.parse(call[1]);
}

/**
 * Raw retained payload string for a lighting-app group under network 254 / app 56.
 * @param {jest.Mock} publish
 * @param {string} component
 * @param {string|number} group
 * @param {string} [prefix='testhomeassistant']
 * @returns {string|null}
 */
function rawPayload(publish, component, group, prefix = 'testhomeassistant') {
    const topic = `${prefix}/${component}/cgateweb_254_56_${group}/config`;
    const call = publish.mock.calls.find(([t, payload]) => t === topic && payload);
    return call ? call[1] : null;
}

/**
 * Parsed payload for a lighting-app group under network 254 / app 56.
 * @param {jest.Mock} publish
 * @param {string} component
 * @param {string|number} group
 * @param {string} [prefix='testhomeassistant']
 * @returns {Object|null}
 */
function payloadFor(publish, component, group, prefix = 'testhomeassistant') {
    const raw = rawPayload(publish, component, group, prefix);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Publish the standard MOCK_TREEXML tree for network 254.
 * @param {import('../../src/haDiscovery')} discovery
 * @param {Object} [tree=MOCK_TREEXML_RESULT_NET254]
 */
function publishTree(discovery, tree = MOCK_TREEXML_RESULT_NET254) {
    discovery._publishDiscoveryFromTree('254', tree);
}

module.exports = {
    MOCK_TREEXML_RESULT_NET254,
    TREEXML_NET254,
    flatTreeNet254,
    PARTIAL_GROUPS_TREE_NET254,
    FULL_GROUPS_TREE_NET254,
    DEFAULT_DISCOVERY_SETTINGS,
    makeDiscovery,
    findDiscoveryCall,
    findDiscoveryPayload,
    rawPayload,
    payloadFor,
    publishTree
};
