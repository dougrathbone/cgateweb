const CbusProjectParser = require('../src/cbusProjectParser');
const AdmZip = require('adm-zip');

describe('CbusProjectParser', () => {
    let parser;

    beforeEach(() => {
        parser = new CbusProjectParser();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('parseXML', () => {
        it('should parse CBZ-style XML with Installation > Project > Network > Application > Group', async () => {
            const xml = `<?xml version="1.0"?>
                <Installation>
                    <Project>
                        <Network Address="254" TagName="Home">
                            <Application Address="56" TagName="Lighting">
                                <Group Address="10" TagName="Kitchen Downlights"/>
                                <Group Address="11" TagName="Living Room"/>
                                <Group Address="12" TagName="Bedroom"/>
                            </Application>
                            <Application Address="203" TagName="Enable Control">
                                <Group Address="1" TagName="Garage Door"/>
                            </Application>
                        </Network>
                    </Project>
                </Installation>`;

            const result = await parser.parseXML(xml);

            expect(result.labels).toEqual({
                '254/56/10': 'Kitchen Downlights',
                '254/56/11': 'Living Room',
                '254/56/12': 'Bedroom',
                '254/203/1': 'Garage Door'
            });
            expect(result.stats.networkCount).toBe(1);
            expect(result.stats.groupCount).toBe(4);
            expect(result.stats.labelCount).toBe(4);
            expect(result.networks).toEqual([{ address: '254', name: 'Home' }]);
        });

        it('should parse simpler Network-at-root XML', async () => {
            const xml = `<?xml version="1.0"?>
                <Network Address="254" TagName="Office">
                    <Application Address="56" TagName="Lighting">
                        <Group Address="1" TagName="Reception"/>
                    </Application>
                </Network>`;

            const result = await parser.parseXML(xml);

            expect(result.labels).toEqual({ '254/56/1': 'Reception' });
            expect(result.networks).toEqual([{ address: '254', name: 'Office' }]);
        });

        it('should handle multiple networks', async () => {
            const xml = `<?xml version="1.0"?>
                <Project>
                    <Network Address="254" TagName="Main">
                        <Application Address="56" TagName="Lighting">
                            <Group Address="1" TagName="Light A"/>
                        </Application>
                    </Network>
                    <Network Address="255" TagName="Secondary">
                        <Application Address="56" TagName="Lighting">
                            <Group Address="1" TagName="Light B"/>
                        </Application>
                    </Network>
                </Project>`;

            const result = await parser.parseXML(xml);

            expect(result.labels).toEqual({
                '254/56/1': 'Light A',
                '255/56/1': 'Light B'
            });
            expect(result.stats.networkCount).toBe(2);
        });

        it('should filter by network when option is provided', async () => {
            const xml = `<?xml version="1.0"?>
                <Project>
                    <Network Address="254" TagName="Main">
                        <Application Address="56">
                            <Group Address="1" TagName="Keep"/>
                        </Application>
                    </Network>
                    <Network Address="255" TagName="Other">
                        <Application Address="56">
                            <Group Address="1" TagName="Skip"/>
                        </Application>
                    </Network>
                </Project>`;

            const result = await parser.parseXML(xml, { network: '254' });

            expect(result.labels).toEqual({ '254/56/1': 'Keep' });
            expect(result.stats.networkCount).toBe(1);
        });

        it('should skip groups without a tag name', async () => {
            const xml = `<?xml version="1.0"?>
                <Network Address="254">
                    <Application Address="56">
                        <Group Address="1" TagName="Named"/>
                        <Group Address="2"/>
                    </Application>
                </Network>`;

            const result = await parser.parseXML(xml);

            expect(result.labels).toEqual({ '254/56/1': 'Named' });
            expect(result.stats.groupCount).toBe(2);
            expect(result.stats.labelCount).toBe(1);
        });

        it('should parse Toolkit export with child-element Address, TagName, and DLT tags (real-world CLIPSAL.xml shape)', async () => {
            // Mirrors the structure of a real user-submitted CLIPSAL.xml (GitHub issue #3):
            // Address and TagName are child elements (not attributes) and groups may include
            // a <TagsDLT> block. Regression test so this common shape keeps working.
            const xml = `<?xml version="1.0" encoding="utf-8"?>
                <Installation>
                    <DBVersion>2.3</DBVersion>
                    <Version>1.0</Version>
                    <Project>
                        <TagName>DOUG</TagName>
                        <Address>DOUG</Address>
                        <Network>
                            <TagName>Steve</TagName>
                            <Address>254</Address>
                            <NetworkNumber>254</NetworkNumber>
                            <Application>
                                <TagName>Lighting</TagName>
                                <Address>56</Address>
                                <Group>
                                    <TagName>Main bed blind Southside</TagName>
                                    <Address>0</Address>
                                    <TagsDLT>
                                        <TagDLT>
                                            <LanguageID>1</LanguageID>
                                            <FlavourID>1</FlavourID>
                                            <TagType>TEXT</TagType>
                                            <TagValue>Southside</TagValue>
                                        </TagDLT>
                                    </TagsDLT>
                                </Group>
                                <Group>
                                    <TagName>Bed 2 Large blind</TagName>
                                    <Address>21</Address>
                                </Group>
                            </Application>
                        </Network>
                    </Project>
                </Installation>`;

            const result = await parser.parseXML(xml);

            expect(result.labels).toEqual({
                '254/56/0': 'Main bed blind Southside',
                '254/56/21': 'Bed 2 Large blind'
            });
            expect(result.networks).toEqual([{ address: '254', name: 'Steve' }]);
            expect(result.stats.networkCount).toBe(1);
            expect(result.stats.groupCount).toBe(2);
            expect(result.stats.labelCount).toBe(2);
        });

        it('should handle empty XML gracefully', async () => {
            const xml = `<?xml version="1.0"?><Root/>`;
            const result = await parser.parseXML(xml);
            expect(result.labels).toEqual({});
            expect(result.stats.groupCount).toBe(0);
        });

        it('should reject invalid XML', async () => {
            await expect(parser.parseXML('not xml at all <<<'))
                .rejects.toThrow('XML parse error');
        });

        it('should handle Label attribute as alternative to TagName', async () => {
            const xml = `<?xml version="1.0"?>
                <Network Address="254">
                    <Application Address="56">
                        <Group Address="1" Label="Kitchen Via Label"/>
                    </Application>
                </Network>`;

            const result = await parser.parseXML(xml);
            expect(result.labels).toEqual({ '254/56/1': 'Kitchen Via Label' });
        });
    });

    describe('parse (auto-detect format)', () => {
        it('should parse raw XML from a Buffer', async () => {
            const xml = `<?xml version="1.0"?>
                <Network Address="254">
                    <Application Address="56">
                        <Group Address="1" TagName="Test"/>
                    </Application>
                </Network>`;

            const result = await parser.parse(Buffer.from(xml), 'test.xml');

            expect(result.labels).toEqual({ '254/56/1': 'Test' });
            expect(result.source).toBe('test.xml');
        });

        it('should parse a CBZ (ZIP) buffer', async () => {
            const xml = `<?xml version="1.0"?>
                <Network Address="254">
                    <Application Address="56">
                        <Group Address="5" TagName="From CBZ"/>
                    </Application>
                </Network>`;

            const zip = new AdmZip();
            zip.addFile('project.xml', Buffer.from(xml));
            const zipBuffer = zip.toBuffer();

            const result = await parser.parse(zipBuffer, 'project.cbz');

            expect(result.labels).toEqual({ '254/56/5': 'From CBZ' });
            expect(result.source).toBe('project.cbz');
        });

        it('should throw if CBZ contains no XML file', async () => {
            const zip = new AdmZip();
            zip.addFile('readme.txt', Buffer.from('hello'));
            const zipBuffer = zip.toBuffer();

            await expect(parser.parse(zipBuffer, 'bad.cbz'))
                .rejects.toThrow('does not contain an XML file');
        });

        it('parses a CBZ whose XML entry has an uppercase .XML extension (Toolkit on Windows)', async () => {
            const xml = '<?xml version="1.0"?><Network Address="254"><Application Address="56"><Group Address="7" TagName="Upper"/></Application></Network>';
            const zip = new AdmZip();
            zip.addFile('PROJECT.XML', Buffer.from(xml));
            const result = await parser.parse(zip.toBuffer(), 'project.cbz');
            expect(result.labels).toEqual({ '254/56/7': 'Upper' });
        });

        it('parses a CBZ where the project file has no .xml extension (content-sniffed)', async () => {
            const xml = '<?xml version="1.0"?><Network Address="254"><Application Address="56"><Group Address="8" TagName="Sniffed"/></Application></Network>';
            const zip = new AdmZip();
            zip.addFile('project.cbzdata', Buffer.from(xml));
            const result = await parser.parse(zip.toBuffer(), 'project.cbz');
            expect(result.labels).toEqual({ '254/56/8': 'Sniffed' });
        });

        it('rejects a CBZ whose declared decompressed total exceeds the cap (zip-bomb protection)', async () => {
            // Build a real zip and configure the parser with a tiny cap so a
            // single small entry triggers the guard. The production default
            // is 100MB; we shrink it to 10 bytes here to exercise the same
            // code path without needing a malicious compressor.
            const tinyCapParser = new (require('../src/cbusProjectParser'))({ maxDecompressedBytes: 10 });
            const zip = new AdmZip();
            zip.addFile('project.xml', Buffer.from('<x>this content is more than 10 bytes</x>'));
            const zipBuffer = zip.toBuffer();

            await expect(tinyCapParser.parse(zipBuffer, 'bomb.cbz'))
                .rejects.toThrow(/zip-bomb protection|decompressed size exceeds/i);
        });

        // AdmZip's addFile sanitises path-traversal on write, so we cannot
        // craft a malicious archive from JS. Test the validator directly -
        // it's the same predicate _extractCBZ calls in production.
        it('_isSafeZipEntryName rejects path-traversal / absolute paths', () => {
            const { _isSafeZipEntryName } = require('../src/cbusProjectParser');
            expect(_isSafeZipEntryName('project.xml')).toBe(true);
            expect(_isSafeZipEntryName('subdir/project.xml')).toBe(true);
            expect(_isSafeZipEntryName('../etc/passwd')).toBe(false);
            expect(_isSafeZipEntryName('foo/../../etc/passwd')).toBe(false);
            expect(_isSafeZipEntryName('/etc/passwd')).toBe(false);
            expect(_isSafeZipEntryName('foo\\..\\..\\bar')).toBe(false);
            // Windows-style absolute paths must be rejected on every host OS,
            // not just Windows: path.isAbsolute() is platform-specific and a
            // POSIX host would otherwise let these through.
            expect(_isSafeZipEntryName('C:\\Windows\\system32')).toBe(false);
            expect(_isSafeZipEntryName('C:/Windows/system32')).toBe(false);
            expect(_isSafeZipEntryName('\\\\server\\share\\file')).toBe(false);
            expect(_isSafeZipEntryName('\\foo')).toBe(false);
            expect(_isSafeZipEntryName('D:relative')).toBe(false);
            expect(_isSafeZipEntryName('')).toBe(false);
            expect(_isSafeZipEntryName(undefined)).toBe(false);
        });
    });
});
