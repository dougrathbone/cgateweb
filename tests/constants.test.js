const constants = require('../src/constants');

describe('constants HVAC cleanup', () => {
    it('does not export the bogus app-201 HVAC default', () => {
        expect(constants.DEFAULT_CBUS_APP_HVAC).toBeUndefined();
    });
});
