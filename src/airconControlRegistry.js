// @ts-check
/**
 * Remembers what cgateweb needs to *control* each native C-Bus Air Conditioning
 * thermostat, learned from the thermostat's own broadcasts.
 *
 * Writes can't be keyed by source unit the way reads are: the C-Gate command
 * `AIRCON SET_ZONE_HVAC_MODE` targets a **ward + zone-list** (and a plant
 * `type`), not a unit. Two thermostats often share a ward and are distinguished
 * only by their zone-list, so we must echo back the exact ward/zones/type the
 * thermostat reported. This registry captures those from each decoded mode
 * reading so a Home Assistant command for unit 202 controls 202, not 201.
 *
 * Verified command syntax (C-Gate v3.3.2 HELP):
 *   AIRCON SET_ZONE_HVAC_MODE <app> <ward> <zone-list> <mode> <rawlevel>
 *       <setbackenabled> <guardenabled> <useauxlevel> <type> <level> <auxlevel>
 *   AIRCON SET_WARD_OFF <app> <ward>
 *   AIRCON SET_WARD_ON  <app> <ward>
 */

// HA climate mode string → C-Bus HVAC mode code (reverse of airconDecoder's map).
const HVAC_CODE_BY_MODE = { off: 0, heat: 1, cool: 2, auto: 3, fan_only: 4 };

// Fan Only carries no temperature: the thermostat sends rawlevel=1 with the
// 0x7F00 (32512) "no level" sentinel.
const FAN_LEVEL_SENTINEL = 32512;
// Fallback target when we must send a temperature but have never seen one.
const DEFAULT_SETPOINT_C = 21;

class AirconControlRegistry {
    constructor() {
        this._byUnit = new Map(); // `${network}/${sourceUnit}` -> control state
    }

    static _key(network, unit) {
        return `${network}/${unit}`;
    }

    /**
     * Capture control state from a decoded `mode` reading. No-op for other kinds
     * or readings without a source unit.
     */
    recordModeReading(reading) {
        if (!reading || reading.kind !== 'mode' || reading.sourceUnit === null || reading.sourceUnit === undefined) {
            return;
        }
        const key = AirconControlRegistry._key(reading.network, reading.sourceUnit);
        const prev = this._byUnit.get(key) || {};
        const isOn = reading.modeRaw !== null && reading.modeRaw !== undefined && reading.modeRaw !== 0;
        const keep = (value, fallback) => (value !== null && value !== undefined ? value : fallback);
        this._byUnit.set(key, {
            network: reading.network,
            application: reading.application,
            ward: reading.zoneGroup,
            zones: reading.zones,
            // Prefer the plant type seen while running; off broadcasts carry
            // type 255 ("Any", §25.6.4) which won't drive the plant on.
            type: (isOn && reading.type !== null && reading.type !== undefined) ? reading.type : prev.type,
            modeRaw: (reading.modeRaw !== null && reading.modeRaw !== undefined) ? reading.modeRaw : prev.modeRaw,
            // Off broadcasts carry setpointRaw=0 as a sentinel; keep the last active target.
            setpointRaw: (isOn && reading.setpointRaw > 0) ? reading.setpointRaw : prev.setpointRaw,
            // Mode & Flags byte (§25.6.3) + Aux Level, echoed back on writes so
            // an HA-originated command doesn't silently clear the thermostat's
            // own setback/guard/aux configuration.
            setbackEnabled: keep(reading.setbackEnabled, prev.setbackEnabled),
            guardEnabled: keep(reading.guardEnabled, prev.guardEnabled),
            auxLevelUsed: keep(reading.auxLevelUsed, prev.auxLevelUsed),
            auxLevel: keep(reading.auxLevel, prev.auxLevel)
        });
    }

    get(network, unit) {
        return this._byUnit.get(AirconControlRegistry._key(network, unit)) || null;
    }
}

/**
 * Build an `AIRCON SET_ZONE_HVAC_MODE` command line (no trailing newline).
 * The setback/guard/useaux/aux fields default to the values C-Bus thermostats
 * broadcast in normal operation (0/0/1/0); callers pass the flags learned by
 * the registry so a write echoes the thermostat's own configuration (§25.6.3).
 */
function buildSetZoneHvacMode({ cbusname, network, application, ward, zones, modeRaw, rawlevel, setback = 0, guard = 0, useaux = 1, type, level, aux = 0 }) {
    return `AIRCON SET_ZONE_HVAC_MODE //${cbusname}/${network}/${application} ${ward} ${zones} ${modeRaw} ${rawlevel} ${setback} ${guard} ${useaux} ${type} ${level} ${aux}`;
}

function buildSetWardOff({ cbusname, network, application, ward }) {
    return `AIRCON SET_WARD_OFF //${cbusname}/${network}/${application} ${ward}`;
}

module.exports = {
    AirconControlRegistry,
    HVAC_CODE_BY_MODE,
    FAN_LEVEL_SENTINEL,
    DEFAULT_SETPOINT_C,
    buildSetZoneHvacMode,
    buildSetWardOff
};
