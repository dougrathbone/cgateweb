const { decodeLine, appId } = require('../../src/applicationDecoders/airconDecoder');

describe('airconDecoder — appId', () => {
    it('declares Air Conditioning app id 172', () => {
        expect(appId).toBe('172');
    });
});

describe('airconDecoder — zone_temperature', () => {
    // Ground-truth fixture from live PICED capture:
    // # aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-...
    // PICED decoded raw 4431 as 17°C.  Encoding: °C = raw / 256

    const LINE_WITH_HASH_PREFIX = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
    const LINE_WITHOUT_HASH_PREFIX = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
    const LINE_WITHOUT_METADATA = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0';

    // --- full object equality for canonical fixture (includes sourceUnit) ---
    it('decodes a hash-prefixed zone_temperature line to the expected reading', () => {
        // Arrange
        const line = LINE_WITH_HASH_PREFIX;
        // Act
        const result = decodeLine(line);
        // Assert
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '250',
            celsius: 17.3,
            sensorStatus: 0,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes a bare (no # prefix) zone_temperature line identically', () => {
        expect(decodeLine(LINE_WITHOUT_HASH_PREFIX)).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '250',
            celsius: 17.3,
            sensorStatus: 0,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes a line without trailing metadata with sourceUnit null', () => {
        expect(decodeLine(LINE_WITHOUT_METADATA)).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: null,
            celsius: 17.3,
            sensorStatus: 0,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    // --- verbatim PICED capture fixtures (two thermostats) ---
    it('decodes sourceunit=201 multi-zone temperature: celsius 17.4, sourceUnit 201, zoneGroup 1, zones 0,1,2,3,4', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4467 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const result = decodeLine(line);
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            celsius: 17.4,
            sensorStatus: 0,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes sourceunit=202 single-zone temperature: celsius 17.8, sourceUnit 202, zones 0', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0 4545 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const result = decodeLine(line);
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0',
            sourceUnit: '202',
            celsius: 17.8,
            sensorStatus: 0,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    // --- various raw temperature values ---
    it('decodes raw 4480 as celsius 17.5 (4480 / 256 = 17.5)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4480 0';
        expect(decodeLine(line).celsius).toBe(17.5);
    });

    it('decodes raw 4608 as celsius 18 (4608 / 256 = 18.0)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4608 0';
        expect(decodeLine(line).celsius).toBe(18);
    });

    it('decodes raw 4412 as celsius 17.2 (4412 / 256 ≈ 17.234 → rounds to 17.2)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4412 0';
        expect(decodeLine(line).celsius).toBe(17.2);
    });

    // --- signed 2's complement temperatures (spec §25.5.1: -37.9°C = $DA1A) ---
    it('decodes a signed-rendered negative temperature: raw -9702 → -37.9°C ($DA1A)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 -9702 0';
        expect(decodeLine(line).celsius).toBe(-37.9);
    });

    it('decodes an unsigned-rendered negative temperature: raw 55834 ($DA1A) → -37.9°C', () => {
        // C-Gate may render the two bytes unsigned; 55834 - 65536 = -9702.
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 55834 0';
        expect(decodeLine(line).celsius).toBe(-37.9);
    });

    it('returns null for raw values outside both 2-byte renderings (65536)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 65536 0';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for raw values below the signed 2-byte minimum (-32769)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 -32769 0';
        expect(decodeLine(line)).toBeNull();
    });

    // --- sensor status (spec §25.8.6 / §25.6.12) ---
    it('suppresses the temperature when the sensor reports total failure (status 3)', () => {
        // §25.8.6: at "Sensor total failure" the Temperature field is meaningless.
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 4431 3';
        const r = decodeLine(line);
        expect(r.celsius).toBeNull();
        expect(r.sensorStatus).toBe(3);
    });

    it('keeps the temperature for a degraded-but-working sensor (status 1)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 4431 1';
        const r = decodeLine(line);
        expect(r.celsius).toBe(17.3);
        expect(r.sensorStatus).toBe(1);
    });

    it('decodes with sensorStatus null when the field is absent', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431';
        const r = decodeLine(line);
        expect(r.celsius).toBe(17.3);
        expect(r.sensorStatus).toBeNull();
    });

    it('decodes with sensorStatus null when the field is not numeric', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0 4431 notanumber';
        const r = decodeLine(line);
        expect(r.celsius).toBe(17.3);
        expect(r.sensorStatus).toBeNull();
    });
});

describe('airconDecoder — set_zone_hvac_mode', () => {
    // Verbatim from PICED log:
    // aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=201 OID=...
    // aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 0 #sourceunit=202 OID=...
    // Params after addr/zoneGroup/zoneList: f0..f7 (spec §25.8.10)
    //   f0=mode (0=off,1=heat,2=cool,3=auto,4=fan_only), f5=HVAC type (§25.6.4),
    //   f6=setpoint raw (°C=f6/256), f7=Aux Level (§25.6.11: bits 0-5 fan speed,
    //   bit 6 fan mode)

    it('decodes heat mode (sourceunit=202, setpoint 5632→22°C)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'mode',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0',
            sourceUnit: '202',
            mode: 'heat',
            modeRaw: 1,
            levelIsRaw: false,
            setbackEnabled: false,
            guardEnabled: false,
            auxLevelUsed: true,
            setpoint: 22,
            setpointRaw: 5632,
            type: 1,
            auxLevel: 0,
            fanSpeed: 0,
            fanMode: 'automatic',
            verb: 'set_zone_hvac_mode'
        });
    });

    it('decodes off mode (sourceunit=201, setpoint null because f6=0)', () => {
        // Off fixture trailing fields: f0=0(off) f1=0 f2=0 f3=0 f4=1 f5=255 f6=0 f7=0.
        // The 255 sits at f5 (not the setpoint); f6=0 → setpoint null.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'mode',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            mode: 'off',
            modeRaw: 0,
            levelIsRaw: false,
            setbackEnabled: false,
            guardEnabled: false,
            auxLevelUsed: true,
            setpoint: null,
            setpointRaw: 0,
            type: 255,
            auxLevel: 0,
            fanSpeed: 0,
            fanMode: 'automatic',
            verb: 'set_zone_hvac_mode'
        });
    });

    it('decodes cool mode (real capture 2026-06-11: f0=2, setpoint 3840→15°C)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 0 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('cool');
        expect(result.modeRaw).toBe(2);
        expect(result.setpoint).toBe(15);
    });

    it('decodes auto/heat-cool mode (real capture 2026-06-11: f0=3, setpoint 5632→22°C)', () => {
        // PICED labels code 3 "Heat/Cool (Auto)"; we publish HA mode string "auto".
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 3 0 0 0 1 3 5632 63 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('auto');
        expect(result.modeRaw).toBe(3);
        expect(result.setpoint).toBe(22);
    });

    it('decodes fan_only mode with the Level-is-Raw flag (real capture 2026-06-11: f1=1, f6=32512 → setpoint null)', () => {
        // Fan Only carries a raw fan level, not a temperature: f1=1 marks f6 as a
        // raw level (§25.5.3), here 32512 ≈ 99.2% output. Must NOT decode as 127°C.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 4 1 0 0 1 3 32512 0 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('fan_only');
        expect(result.modeRaw).toBe(4);
        expect(result.levelIsRaw).toBe(true);
        expect(result.setpoint).toBeNull();
    });

    it('treats f6 as a raw level, not a setpoint, whenever f1=1 — even for small levels (spec §25.5.3)', () => {
        // f6=5120 would decode to a bogus 20.0°C if the Level-is-Raw flag were
        // ignored; with f1=1 it is ~15.6% plant output, so setpoint is null.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 4 1 0 0 1 3 5120 0 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.levelIsRaw).toBe(true);
        expect(result.setpoint).toBeNull();
        expect(result.setpointRaw).toBe(5120);
    });

    it('decodes unknown mode code (f0=7) → mode null, modeRaw 7, setpoint still parsed', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 7 0 0 0 1 1 5632 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.kind).toBe('mode');
        expect(result.mode).toBeNull();
        expect(result.modeRaw).toBe(7);
        expect(result.setpoint).toBe(22);
    });

    it('decodes auto mode (f0=3)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 3 0 0 0 1 1 6144 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('auto');
        expect(result.modeRaw).toBe(3);
        expect(result.setpoint).toBe(24);
    });

    it('decodes fan_only mode (f0=4)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 4 0 0 0 1 1 6400 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('fan_only');
        expect(result.modeRaw).toBe(4);
        expect(result.setpoint).toBe(25);
    });

    it('decodes the Mode & Flags enable bits (f2 setback, f3 guard, f4 aux-used) for write-back echo', () => {
        // Spec §25.6.3: B (setback) / G (guard) / A (aux level used) bits.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 1 0 1 1 0 3 5632 64 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.setbackEnabled).toBe(true);
        expect(r.guardEnabled).toBe(true);
        expect(r.auxLevelUsed).toBe(false);
        expect(r.auxLevel).toBe(64);
        expect(r.fanMode).toBe('continuous');
    });

    it('returns null when fewer than 7 trailing fields (f0..f6 not all present)', () => {
        // Only 5 fields after zoneGroup/zones → can't read f6
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null when f0 is not a valid integer', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 notanumber 0 0 0 1 1 5632 0';
        expect(decodeLine(line)).toBeNull();
    });
});

describe('airconDecoder — set_zone_hvac_mode fan speed/mode from the Aux Level', () => {
    // Spec §25.8.10: Set Zone HVAC Mode = <Zone Group> <Zone List> <HVAC Mode &
    // Flags> <HVAC Type> <Level> <Aux Level> — the Aux Level is the last argument
    // (f7). Spec §25.6.11: bits 0-5 = fan speed (0 = default speed, 1-63 plant
    // dependant), bit 6 = fan mode (0=automatic, 1=continuous), bit 7 reserved.
    // Fixtures below are spec-derived variants of the real 2026-06-11 cool-mode
    // capture; the f7=63 one is the verbatim auto-mode capture.

    it('decodes fan speed 3, automatic (spec-derived: f7=3)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 3 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fanSpeed).toBe(3);
        expect(r.fanMode).toBe('automatic');
    });

    it('decodes fan mode continuous (spec-derived: f7=67 = 0x40|3)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 67 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fanSpeed).toBe(3);
        expect(r.fanMode).toBe('continuous');
    });

    it('tolerates the reserved bit 7 being set (spec-derived: f7=131 = 0x80|3)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 131 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fanSpeed).toBe(3);
        expect(r.fanMode).toBe('automatic');
    });

    it('decodes the real-capture aux level 63 (verbatim 2026-06-11 auto line: f7=63 → speed 63, automatic)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 3 0 0 0 1 3 5632 63 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fanSpeed).toBe(63);
        expect(r.fanMode).toBe('automatic');
    });

    it('returns null fan fields when the aux level field is absent (9 params)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 #sourceunit=202 OID=x';
        const r = decodeLine(line);
        expect(r.mode).toBe('heat');
        expect(r.setpoint).toBe(22);
        expect(r.fanSpeed).toBeNull();
        expect(r.fanMode).toBeNull();
    });

    it('returns null fan fields when the aux level is not a valid integer', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 notanumber';
        const r = decodeLine(line);
        expect(r.mode).toBe('heat');
        expect(r.fanSpeed).toBeNull();
        expect(r.fanMode).toBeNull();
    });
});

describe('airconDecoder — set_ward_on / set_ward_off', () => {
    // Verbatim from PICED log:
    // aircon set_ward_on //THEGAFF/254/172 1 #sourceunit=202 OID=...
    // aircon set_ward_off //THEGAFF/254/172 1 #sourceunit=201 OID=...

    it('decodes set_ward_on (sourceunit=202) → kind state, on true', () => {
        const line = 'aircon set_ward_on //THEGAFF/254/172 1 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'state',
            network: '254',
            application: '172',
            zoneGroup: '1',
            sourceUnit: '202',
            on: true,
            verb: 'set_ward_on'
        });
    });

    it('decodes set_ward_off (sourceunit=201) → kind state, on false', () => {
        const line = 'aircon set_ward_off //THEGAFF/254/172 1 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'state',
            network: '254',
            application: '172',
            zoneGroup: '1',
            sourceUnit: '201',
            on: false,
            verb: 'set_ward_off'
        });
    });

    it('decodes set_ward_on without sourceunit → sourceUnit null', () => {
        const line = 'aircon set_ward_on //THEGAFF/254/172 1';
        const result = decodeLine(line);
        expect(result.kind).toBe('state');
        expect(result.on).toBe(true);
        expect(result.sourceUnit).toBeNull();
    });
});

describe('airconDecoder — zone_hvac_plant_status (running action)', () => {
    // Real captures 2026-06-11. Params after addr per spec §25.8.4:
    //   zoneGroup zones <HVAC Type> <HVAC Status> <HVAC Error Code>
    // Status bits per spec §25.6.6: 1=cooling, 2=heating, 4=fan, 8=damper,
    //   32=busy, 64=error, 128=expansion (heating/fan/damper/busy also verified
    //   against PICED text; cooling/error positions now spec-confirmed).

    it('decodes heating+fan+damper, not busy → action heating (real: bitmask 14)', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 14 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'action',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            cooling: false,
            heating: true,
            fan: true,
            damper: true,
            busy: false,
            error: false,
            expansion: false,
            errorCode: 0,
            errorDescription: 'No error',
            action: 'heating',
            verb: 'zone_hvac_plant_status'
        });
    });

    it('decodes the busy flag (real: bitmask 46 = 14 + 32) → busy true, action heating', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 46 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.busy).toBe(true);
        expect(r.heating).toBe(true);
        expect(r.action).toBe('heating');
    });

    it('decodes damper-only (real: bitmask 8) → all plant off, action idle', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 8 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.heating).toBe(false);
        expect(r.cooling).toBe(false);
        expect(r.fan).toBe(false);
        expect(r.action).toBe('idle');
    });

    it('decodes fan running without heat (real: bitmask 44 = 32+8+4) → action fan', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 44 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fan).toBe(true);
        expect(r.heating).toBe(false);
        expect(r.action).toBe('fan');
    });

    it('derives action cooling when the cooling bit is set (synthesised: bit0; position spec-confirmed §25.6.6)', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 13 0 #sourceunit=202 OID=x';
        const r = decodeLine(line);
        expect(r.cooling).toBe(true);
        expect(r.action).toBe('cooling');
    });
});

describe('airconDecoder — zone_hvac_plant_status error state (spec §25.8.4/§25.6.5/§25.6.6)', () => {
    // Spec-derived fixtures built on the captured line shape: the 5th argument
    // (after <HVAC Status>) is the <HVAC Error Code> per §25.8.4.

    it('decodes error bit set + error code $04 → temperature sensor failure; action unchanged', () => {
        // bitmask 78 = 64(error) + 8(damper) + 4(fan) + 2(heating)
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 78 4 #sourceunit=201 OID=x';
        expect(decodeLine(line)).toEqual({
            kind: 'action',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            cooling: false,
            heating: true,
            fan: true,
            damper: true,
            busy: false,
            error: true,
            expansion: false,
            errorCode: 4,
            errorDescription: 'Temperature sensor failure',
            action: 'heating', // action reflects running state; error is separate state
            verb: 'zone_hvac_plant_status'
        });
    });

    it('decodes the expansion bit (bit 7) without affecting the plant bits', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 128 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.expansion).toBe(true);
        expect(r.error).toBe(false);
        expect(r.action).toBe('idle');
    });

    // §25.6.5 error code table, incl. the reserved and developer-specific ranges.
    it.each([
        [0, 'No error'],
        [1, 'Heater total failure'],
        [2, 'Cooler total failure'],
        [3, 'Fan total failure'],
        [4, 'Temperature sensor failure'],
        [5, 'Heater temporary problem'],
        [6, 'Cooler temporary problem'],
        [7, 'Fan temporary problem'],
        [8, 'Heater service required'],
        [9, 'Cooler service required'],
        [10, 'Fan service required'],
        [11, 'Filter replacement required'],
        [12, 'Reserved (0x0C)'],
        [127, 'Reserved (0x7F)'],
        [128, 'Developer-specific (0x80)'],
        [255, 'Developer-specific (0xFF)']
    ])('maps error code %i → "%s"', (code, description) => {
        const line = `# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 64 ${code} #sourceunit=201 OID=x`;
        const r = decodeLine(line);
        expect(r.errorCode).toBe(code);
        expect(r.errorDescription).toBe(description);
    });

    it('tolerates a missing error code field (4 params) → errorCode/errorDescription null', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 14';
        const r = decodeLine(line);
        expect(r.action).toBe('heating');
        expect(r.error).toBe(false);
        expect(r.errorCode).toBeNull();
        expect(r.errorDescription).toBeNull();
    });

    it('tolerates a non-numeric error code field → errorCode/errorDescription null', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 14 notanumber';
        const r = decodeLine(line);
        expect(r.action).toBe('heating');
        expect(r.errorCode).toBeNull();
        expect(r.errorDescription).toBeNull();
    });
});

describe('airconDecoder — null returns for other verbs and non-aircon lines', () => {
    it('returns null for an unsupported aircon verb (set_plant_hvac_level)', () => {
        const line = '# aircon set_plant_hvac_level //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 1 3 127 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for a non-aircon lighting line', () => {
        expect(decodeLine('lighting on 254/56/4')).toBeNull();
    });

    it('returns null for a malformed zone_temperature with non-numeric rawTemp', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 notanumber 0';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for null input', () => {
        expect(decodeLine(null)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(decodeLine('')).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(decodeLine(undefined)).toBeNull();
    });
});

describe('airconDecoder — humidity verbs (spec-derived §25.8.5/§25.8.7/§25.8.12)', () => {
    // NOTE: no live captures exist for the humidity application; these fixtures
    // are built from the spec's message layouts and C-Gate's rendering
    // convention, mirroring the verified HVAC fixtures field-for-field.

    it('decodes zone_humidity: raw 32768 → 50.0%, sensor status ok', () => {
        const line = '# aircon zone_humidity //THEGAFF/254/172 1 0,1,2,3,4 32768 0 #sourceunit=201 OID=x';
        expect(decodeLine(line)).toEqual({
            kind: 'humidity',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            humidity: 50,
            sensorStatus: 0,
            unit: '%',
            verb: 'zone_humidity'
        });
    });

    it('suppresses the humidity when the sensor reports total failure (status 3, §25.8.7)', () => {
        const line = 'aircon zone_humidity //THEGAFF/254/172 1 0 32768 3';
        const r = decodeLine(line);
        expect(r.humidity).toBeNull();
        expect(r.sensorStatus).toBe(3);
    });

    it('rejects humidity values above the two-byte range', () => {
        expect(decodeLine('aircon zone_humidity //THEGAFF/254/172 1 0 65536 0')).toBeNull();
    });

    it('decodes set_zone_humidity_mode: humidify only at 45%', () => {
        // f0=1 (humidify only, §25.6.7), f5=1 (evaporator, §25.6.8), f6=29491 (≈45%)
        const line = 'aircon set_zone_humidity_mode //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 1 1 29491 0 #sourceunit=201 OID=x';
        expect(decodeLine(line)).toEqual({
            kind: 'humidity_mode',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            mode: 'humidify',
            modeRaw: 1,
            levelIsRaw: false,
            humiditySetpoint: 45,
            type: 1,
            verb: 'set_zone_humidity_mode'
        });
    });

    it('treats the humidity level as raw (no setpoint) when f1=1', () => {
        const line = 'aircon set_zone_humidity_mode //THEGAFF/254/172 1 0,1,2,3,4 1 1 0 0 1 1 16384 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.levelIsRaw).toBe(true);
        expect(r.humiditySetpoint).toBeNull();
    });

    it('decodes zone_humidity_plant_status: dehumidifying + error code (§25.6.9/§25.6.10)', () => {
        // bitmask 66 = 64(error) + 2(dehumidifying); code 4 = humidity sensor failure
        const line = '# aircon zone_humidity_plant_status //THEGAFF/254/172 1 0,1,2,3,4 2 66 4 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.kind).toBe('humidity_action');
        expect(r.dehumidifying).toBe(true);
        expect(r.error).toBe(true);
        expect(r.errorCode).toBe(4);
        expect(r.errorDescription).toBe('Humidity sensor failure');
        expect(r.action).toBe('dehumidifying');
    });
});
