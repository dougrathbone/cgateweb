// @ts-check
const temperatureDecoder = require('./temperatureDecoder');

// appId → decoder. Only specialised applications appear here; lighting/cover/
// PIR/trigger remain on CBusEvent's regex fast path.
const DECODERS = new Map([
    [temperatureDecoder.appId, temperatureDecoder]
]);

function getDecoder(appId) {
    return DECODERS.get(String(appId));
}

module.exports = { getDecoder };
