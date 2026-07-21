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
