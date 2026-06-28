// In-process end-to-end test for HA Discovery startup race protections
// (v1.8.1 retry + v1.8.4 diagnostic sensor + v1.8.5 event-driven refresh).
//
// Wires a real CommandResponseProcessor to a real HaDiscovery (and a real
// EventPublisher), feeds raw C-Gate command-port lines through processLine(),
// and asserts that MQTT publishes and outbound C-Gate commands match what HA
// users would actually observe.

const CommandResponseProcessor = require('../src/commandResponseProcessor');
const EventPublisher = require('../src/eventPublisher');
const HaDiscovery = require('../src/haDiscovery');
const {
    CGATE_CMD_TREEXML,
    NEWLINE,
    DISCOVERY_STATE_DISCOVERING,
    DISCOVERY_STATE_OK,
    DISCOVERY_STATE_PAUSED
} = require('../src/constants');

// Minimal but realistic TreeXML payload — flat application format, two lighting groups.
const TREE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Network>
  <NetworkNumber>254</NetworkNumber>
  <Unit>
    <UnitAddress>1</UnitAddress>
    <Application>
      <ApplicationAddress>56</ApplicationAddress>
      <Group>
        <GroupAddress>10</GroupAddress>
        <Label>Kitchen</Label>
      </Group>
      <Group>
        <GroupAddress>11</GroupAddress>
        <Label>Lounge</Label>
      </Group>
    </Application>
  </Unit>
</Network>`;

function buildHarness(overrides = {}) {
    const sentCommands = [];
    const publishes = [];

    const settings = {
        ha_discovery_enabled: true,
        ha_discovery_prefix: 'homeassistant',
        ha_discovery_networks: ['254'],
        cbusname: 'PROJECT',
        getallnetapp: null,
        eventPublishDedupWindowMs: 0,
        log_level: 'warn',
        ...overrides
    };

    const publishFn = (topic, payload, options) => {
        publishes.push({ topic, payload, options });
    };

    const sendCommandFn = (cmd) => {
        sentCommands.push(cmd);
    };

    const haDiscovery = new HaDiscovery(settings, publishFn, sendCommandFn);

    const eventPublisher = new EventPublisher({
        settings,
        publishFn,
        mqttOptions: { retain: true, qos: 0 }
    });

    const processor = new CommandResponseProcessor({
        eventPublisher,
        haDiscovery,
        onObjectStatus: () => {},
        // Mirrors the wiring in BridgeInitializationService.handleCommandError:
        // forward 4xx/5xx responses to HaDiscovery so it can recognise the
        // 401 "Network not found" that signals a TREEXML startup race.
        onCommandError: (code, statusData) => haDiscovery.handleCommandError(code, statusData)
    });

    return { processor, haDiscovery, settings, sentCommands, publishes };
}

function statePublishes(publishes, network) {
    return publishes
        .filter(p => p.topic === `cbus/read/${network}///discovery_status`)
        .map(p => p.payload);
}

function configPublishes(publishes, network) {
    return publishes.filter(p => p.topic === `homeassistant/sensor/cgateweb_discovery_${network}/config`);
}

describe('HA Discovery e2e (real processor + real haDiscovery)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('happy path: TREEXML 343/347/344 sequence advances diagnostic to ok', async () => {
        const h = buildHarness();
        h.haDiscovery.trigger();

        // First TREEXML went out, sensor is "discovering"
        expect(h.sentCommands).toEqual([`${CGATE_CMD_TREEXML} //PROJECT/254${NEWLINE}`]);
        expect(statePublishes(h.publishes, '254')).toEqual([DISCOVERY_STATE_DISCOVERING]);
        expect(configPublishes(h.publishes, '254')).toHaveLength(1);

        // C-Gate responds with the standard tree sequence
        h.processor.processLine('343-Begin TreeXML');
        for (const line of TREE_XML.split('\n')) {
            h.processor.processLine(`347-${line}`);
        }
        h.processor.processLine('344-End TreeXML');

        // xml2js.parseString is async — flush microtasks
        await Promise.resolve();
        await Promise.resolve();

        const states = statePublishes(h.publishes, '254');
        expect(states[states.length - 1]).toBe(DISCOVERY_STATE_OK);

        // Discovery payloads for Kitchen + Lounge published under homeassistant/light/...
        const lightConfigs = h.publishes.filter(
            p => /^homeassistant\/light\/cgateweb_254_56_(10|11)\/config$/.test(p.topic)
        );
        expect(lightConfigs).toHaveLength(2);
    });

    it('startup race: 401 Network not found triggers retry; eventual success → ok', async () => {
        const h = buildHarness();
        h.haDiscovery.trigger();
        expect(h.sentCommands).toHaveLength(1);

        // C-Gate returns 401 because the network isn't loaded yet
        h.processor.processLine('401-Bad object or device ID: Network not found');

        // No new command yet — retry is pending
        expect(h.sentCommands).toHaveLength(1);

        // Diagnostic stays "discovering" through the retry (de-duped)
        expect(statePublishes(h.publishes, '254')).toEqual([DISCOVERY_STATE_DISCOVERING]);

        // Wait for the 2s backoff
        jest.advanceTimersByTime(2000);
        expect(h.sentCommands).toHaveLength(2);

        // This time C-Gate has loaded the network — full tree response
        h.processor.processLine('343-Begin TreeXML');
        h.processor.processLine(`347-${TREE_XML}`);
        h.processor.processLine('344-End TreeXML');

        await Promise.resolve();
        await Promise.resolve();

        const states = statePublishes(h.publishes, '254');
        expect(states[states.length - 1]).toBe(DISCOVERY_STATE_OK);
    });

    it('giveup path: 9 consecutive 401s exhaust retry budget, sensor reaches paused', () => {
        const h = buildHarness();
        h.haDiscovery.trigger();

        // 8 retries permitted, 9th failure exhausts the budget
        for (let i = 1; i <= 8; i++) {
            h.processor.processLine('401-Bad object or device ID: Network not found');
            jest.runOnlyPendingTimers();
        }
        h.processor.processLine('401-Bad object or device ID: Network not found');

        const states = statePublishes(h.publishes, '254');
        expect(states[states.length - 1]).toBe(DISCOVERY_STATE_PAUSED);
    });

    it('event-driven refresh: timestamped 742 Network created triggers TREEXML', () => {
        const h = buildHarness();
        // No initial trigger — simulate the bridge before discovery has run.

        h.processor.processLine(
            '20260504-193110.569 742 //PROJECT/254 c2211b00-28c1-103f-94b5-db702a32859b ' +
            'Network created type=cni address=192.168.0.100:10001'
        );

        expect(h.sentCommands).toEqual([`${CGATE_CMD_TREEXML} //PROJECT/254${NEWLINE}`]);
        expect(statePublishes(h.publishes, '254')).toEqual([DISCOVERY_STATE_DISCOVERING]);
    });

    it('event-driven refresh fires only for configured networks', () => {
        const h = buildHarness({ ha_discovery_networks: ['254'] });

        h.processor.processLine(
            '20260504-193110.569 742 //PROJECT/999 abc Network created type=cni'
        );

        expect(h.sentCommands).toEqual([]);
    });

    it('Network created mid-backoff short-circuits the v1.8.1 retry timer', () => {
        const h = buildHarness();
        h.haDiscovery.trigger();
        h.processor.processLine('401-Bad object or device ID: Network not found');
        // Retry scheduled for 2s.

        const sentBefore = h.sentCommands.length;
        h.processor.processLine(
            '20260504-193110.569 742 //PROJECT/254 uuid Network created type=cni'
        );
        // Event triggered an immediate fresh TREEXML.
        expect(h.sentCommands).toHaveLength(sentBefore + 1);

        // The original retry was canceled — no extra command after the 2s window.
        jest.advanceTimersByTime(2500);
        expect(h.sentCommands).toHaveLength(sentBefore + 1);
    });

    it('non-Network 742 events do not trigger discovery', () => {
        const h = buildHarness();

        h.processor.processLine(
            '20260504-193110.421 742 //PROJECT - Tag information changed at tag address: //PROJECT/Installation oldtag: null newtag: null'
        );
        h.processor.processLine(
            '20260504-193120.394 836 //PROJECT/254/p/12 c21ed110-... unit configuration changed (5 changes)'
        );

        expect(h.sentCommands).toEqual([]);
    });

    it('parser hardening: hyphens inside payload UUIDs do not break parsing', () => {
        const h = buildHarness();

        // Without the v1.8.5 parser fix, the hyphen inside the UUID would be
        // mistaken for the code/data separator and the line would be skipped.
        h.processor.processLine(
            '20260504-193110.569 742 //PROJECT/254 c2211b00-28c1-103f-94b5-db702a32859b Network created type=cni address=192.168.0.100:10001'
        );

        expect(h.sentCommands).toEqual([`${CGATE_CMD_TREEXML} //PROJECT/254${NEWLINE}`]);
    });

    it('Network removed event clears entities and the diagnostic sensor', async () => {
        const h = buildHarness();
        h.haDiscovery.trigger();

        // Drive a complete discovery cycle so we have published entity configs to clean up.
        h.processor.processLine('343-Begin TreeXML');
        for (const line of TREE_XML.split('\n')) {
            h.processor.processLine(`347-${line}`);
        }
        h.processor.processLine('344-End TreeXML');
        await Promise.resolve();
        await Promise.resolve();

        // Sanity: we've published light configs.
        const lightConfigs = h.publishes.filter(
            p => /^homeassistant\/light\/cgateweb_254_56_(10|11)\/config$/.test(p.topic) && p.payload !== ''
        );
        expect(lightConfigs.length).toBeGreaterThan(0);

        // Now C-Gate emits a network-removed event for network 254.
        h.processor.processLine(
            '20260505-101122.000 742 //PROJECT/254 uuid Network removed'
        );

        // Each previously-published light config gets a retained-empty payload (HA delete).
        const lightCleared = h.publishes.filter(
            p => /^homeassistant\/light\/cgateweb_254_56_(10|11)\/config$/.test(p.topic) && p.payload === ''
        );
        expect(lightCleared.length).toBe(lightConfigs.length);

        // The discovery diagnostic sensor itself is also removed.
        const diagCleared = h.publishes.find(
            p => p.topic === 'homeassistant/sensor/cgateweb_discovery_254/config' && p.payload === ''
        );
        expect(diagCleared).toBeDefined();
    });

    it('config payload retains diagnostic shape across the full lifecycle', () => {
        const h = buildHarness();
        h.haDiscovery.trigger();

        const cfg = configPublishes(h.publishes, '254')[0];
        expect(cfg).toBeDefined();
        const payload = JSON.parse(cfg.payload);

        // Required HA Discovery fields
        expect(payload.unique_id).toBe('cgateweb_discovery_254');
        expect(payload.state_topic).toBe('cbus/read/254///discovery_status');
        expect(payload.entity_category).toBe('diagnostic');
        expect(payload.availability_topic).toBe('hello/cgateweb');
        expect(payload.payload_available).toBe('Online');
        expect(payload.payload_not_available).toBe('Offline');

        // Grouped under the existing cgateweb Bridge device so it sits next to
        // the other diagnostics (Bridge Ready, MQTT Connected, etc.).
        expect(payload.device.identifiers).toContain('cgateweb_bridge');

        // Retained so HA always has the latest state cached.
        expect(cfg.options).toEqual({ retain: true, qos: 0 });
    });
});
