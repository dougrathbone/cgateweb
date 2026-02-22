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
    });
});
