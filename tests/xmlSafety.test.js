const {
    assertSafeXmlDocument,
    DEFAULT_MAX_XML_BYTES,
    DEFAULT_MAX_XML_ELEMENT_TOKENS
} = require('../src/xmlSafety');

describe('assertSafeXmlDocument', () => {
    it('accepts a plain network tree', () => {
        expect(() => assertSafeXmlDocument(
            '<?xml version="1.0"?><Network><NetworkNumber>254</NetworkNumber></Network>'
        )).not.toThrow();
    });

    it.each([
        ['DOCTYPE', '<!DOCTYPE foo [<!ENTITY x "y">]><Network/>'],
        ['ENTITY', '<!ENTITY x SYSTEM "file:///etc/passwd"><Network/>'],
        ['lowercase doctype', '<!doctype html><Network/>'],
    ])('rejects XML with %s declarations', (_label, xml) => {
        expect(() => assertSafeXmlDocument(xml))
            .toThrow('XML with DTD or entity declarations is not supported');
    });

    it('rejects oversized documents before scanning DTDs', () => {
        const xml = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>' + 'x'.repeat(100);
        expect(() => assertSafeXmlDocument(xml, { maxBytes: 50 }))
            .toThrow(/zip-bomb protection|exceeds .* bytes/i);
    });

    it('rejects dense element-token bombs', () => {
        const xml = '<?xml version="1.0"?><r>' + '<i/>'.repeat(10) + '</r>';
        expect(() => assertSafeXmlDocument(xml, { maxElementTokens: 8 }))
            .toThrow(/too many elements/i);
    });

    it('exports the shared defaults used by uploads and TreeXML', () => {
        expect(DEFAULT_MAX_XML_BYTES).toBe(100 * 1024 * 1024);
        expect(DEFAULT_MAX_XML_ELEMENT_TOKENS).toBe(2000000);
    });
});
