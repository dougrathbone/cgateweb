// @ts-check
/**
 * Shared XML size / DTD guards used by project-file uploads and C-Gate TreeXML.
 * Keep both paths on the same limits so a compromised C-Gate stream cannot
 * expand entities or grow past the zip-bomb cap that upload already enforces.
 */

/** Default max document size in characters (matches project-file unzip cap). */
const DEFAULT_MAX_XML_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Bound xml2js work independently of byte size: a tiny document can still
 * contain millions of empty elements. Count of '<' tokens is a cheap proxy
 * for element count.
 */
const DEFAULT_MAX_XML_ELEMENT_TOKENS = 2000000;

/**
 * Reject oversized documents, DTDs/entity declarations, and dense element
 * bombs before handing XML to xml2js.
 *
 * @param {string} xmlString
 * @param {{ maxBytes?: number, maxElementTokens?: number }} [options]
 * @throws {Error}
 */
function assertSafeXmlDocument(xmlString, options = {}) {
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : DEFAULT_MAX_XML_BYTES;
    const maxElementTokens = Number.isFinite(options.maxElementTokens) && options.maxElementTokens > 0
        ? options.maxElementTokens
        : DEFAULT_MAX_XML_ELEMENT_TOKENS;

    if (typeof xmlString !== 'string') {
        throw new Error('XML document must be a string');
    }
    // Bound size before regex/token work: a huge document must not pay for
    // DTD scans or a full '<' walk only to be rejected on length.
    if (xmlString.length > maxBytes) {
        throw new Error(
            `XML document exceeds ${maxBytes} bytes; rejecting (zip-bomb protection)`
        );
    }
    // Reject DTDs / entity declarations before handing to the XML parser —
    // xml2js (and libxml-backed parsers) can expand external entities or
    // blow up on billion-laughs style entity expansion.
    if (/<!DOCTYPE/i.test(xmlString) || /<!ENTITY/i.test(xmlString)) {
        throw new Error('XML with DTD or entity declarations is not supported');
    }
    let tokenCount = 0;
    for (let i = 0; i < xmlString.length; i++) {
        if (xmlString.charCodeAt(i) === 60) { // '<'
            tokenCount++;
            if (tokenCount > maxElementTokens) {
                throw new Error(
                    `XML document has too many elements; rejecting (max ${maxElementTokens})`
                );
            }
        }
    }
}

module.exports = {
    DEFAULT_MAX_XML_BYTES,
    DEFAULT_MAX_XML_ELEMENT_TOKENS,
    assertSafeXmlDocument
};
