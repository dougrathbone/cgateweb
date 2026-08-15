// @ts-check
const temperatureDecoder = require('./temperatureDecoder');
const clockDecoder = require('./clockDecoder');

// appId → decoder. Only specialised applications appear here; lighting/cover/
// PIR/trigger remain on CBusEvent's regex fast path.
//
// Clock ($DF/223) is listed for completeness, but its real work happens off
// this path: clock lines carry a two-segment address and are decoded from the
// raw line by cgateWebBridge before CBusEvent ever sees them. Its decodeValue
// returns null by design — see clockDecoder.js.
const DECODERS = new Map([
    [temperatureDecoder.appId, temperatureDecoder],
    [clockDecoder.appId, clockDecoder]
]);

function getDecoder(appId) {
    return DECODERS.get(String(appId));
}

module.exports = { getDecoder };
