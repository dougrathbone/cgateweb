const constants = require('../src/constants');

describe('constants HVAC cleanup', () => {
    it('does not export the bogus app-201 HVAC default', () => {
        expect(constants.DEFAULT_CBUS_APP_HVAC).toBeUndefined();
    });
});

describe('aircon constants', () => {
    it('exports DEFAULT_CBUS_APP_AIRCON as string "172"', () => {
        const c = require('../src/constants');
        expect(c.DEFAULT_CBUS_APP_AIRCON).toBe('172');
    });
});

describe('temperature constants', () => {
    it('exports the Temperature Broadcast app id and current_temperature suffix', () => {
        const c = require('../src/constants');
        expect(c.DEFAULT_CBUS_APP_TEMPERATURE).toBe('25');
        expect(c.MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP).toBe('current_temperature');
    });
});

describe('protocol numeric bounds', () => {
    it('exports HVAC setpoint raw max as 50 °C × 256', () => {
        expect(constants.HVAC_SETPOINT_RAW_MAX).toBe(12800);
    });

    it('exports signed 16-bit and security zone bounds', () => {
        expect(constants.INT16_MIN).toBe(-32768);
        expect(constants.INT16_MAX).toBe(32767);
        expect(constants.UINT16_MAX).toBe(65535);
        expect(constants.INT8_MIN).toBe(-128);
        expect(constants.INT8_MAX).toBe(127);
        expect(constants.SECURITY_ZONE_MIN).toBe(1);
        expect(constants.SECURITY_ZONE_MAX).toBe(127);
    });
});
