const fs = require('fs');
const path = require('path');
const os = require('os');
const LabelLoader = require('../src/labelLoader');

describe('LabelLoader', () => {
    let tmpDir;
    let labelFile;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelloader-test-'));
        labelFile = path.join(tmpDir, 'labels.json');

        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('load', () => {
        it('should return an empty map when no file path is configured', () => {
            const loader = new LabelLoader(null);
            const labels = loader.load();
            expect(labels.size).toBe(0);
        });

        it('should return an empty map when the file does not exist', () => {
            const loader = new LabelLoader(path.join(tmpDir, 'nonexistent.json'));
            const labels = loader.load();
            expect(labels.size).toBe(0);
        });

        it('should load labels from a valid file', () => {
            const data = {
                version: 1,
                source: 'test.cbz',
                labels: {
                    '254/56/10': 'Kitchen',
                    '254/56/11': 'Living Room'
                }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            const labels = loader.load();

            expect(labels.size).toBe(2);
            expect(labels.get('254/56/10')).toBe('Kitchen');
            expect(labels.get('254/56/11')).toBe('Living Room');
        });

        it('should return empty map on invalid JSON', () => {
            fs.writeFileSync(labelFile, 'not json');

            const loader = new LabelLoader(labelFile);
            const labels = loader.load();
            expect(labels.size).toBe(0);
        });

        it('should return empty map if labels key is missing', () => {
            fs.writeFileSync(labelFile, JSON.stringify({ version: 1 }));

            const loader = new LabelLoader(labelFile);
            const labels = loader.load();
            expect(labels.size).toBe(0);
        });

        it('should reject unsupported version', () => {
            fs.writeFileSync(labelFile, JSON.stringify({ version: 999, labels: {} }));

            const loader = new LabelLoader(labelFile);
            const labels = loader.load();
            expect(labels.size).toBe(0);
        });
    });

    describe('save', () => {
        it('should save labels as a proper JSON file', () => {
            const loader = new LabelLoader(labelFile);
            loader.save({ '254/56/10': 'Kitchen', '254/56/11': 'Bedroom' });

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.version).toBe(1);
            expect(saved.labels['254/56/10']).toBe('Kitchen');
            expect(saved.labels['254/56/11']).toBe('Bedroom');
        });

        it('should accept a full file object with version/source', () => {
            const loader = new LabelLoader(labelFile);
            loader.save({
                version: 1,
                source: 'import.cbz',
                generated: '2026-01-01T00:00:00Z',
                labels: { '254/56/1': 'Foyer' }
            });

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.source).toBe('import.cbz');
            expect(saved.labels['254/56/1']).toBe('Foyer');
        });

        it('should update in-memory map after save', () => {
            const loader = new LabelLoader(labelFile);
            loader.save({ '254/56/10': 'Kitchen' });

            expect(loader.getLabels().get('254/56/10')).toBe('Kitchen');
        });

        it('should create parent directories if needed', () => {
            const deepFile = path.join(tmpDir, 'sub', 'dir', 'labels.json');
            const loader = new LabelLoader(deepFile);
            loader.save({ '254/56/1': 'Test' });

            expect(fs.existsSync(deepFile)).toBe(true);
        });

        it('should throw when no file path is configured', () => {
            const loader = new LabelLoader(null);
            expect(() => loader.save({})).toThrow('No label file path configured');
        });

        it('emits labels-changed synchronously after save so in-process callers (web UI) trigger HA Discovery refresh', () => {
            // Regression for the bug where editing labels via the Web UI did
            // NOT update Home Assistant device names. save() wrote the file
            // and updated internal state but never emitted labels-changed -
            // the watcher's self-write grace period then suppressed the
            // file-event-driven emit, so the bridge's HA Discovery
            // re-trigger listener never fired.
            const loader = new LabelLoader(labelFile);
            const events = [];
            loader.on('labels-changed', (labelData) => events.push(labelData));

            loader.save({ '254/56/10': 'Kitchen Bench', '254/56/11': 'Hallway' });

            expect(events.length).toBe(1);
            expect(events[0].labels.get('254/56/10')).toBe('Kitchen Bench');
            expect(events[0].labels.get('254/56/11')).toBe('Hallway');
        });

        it('labels-changed payload carries areas / type_overrides / entity_ids / exclude in addition to labels', () => {
            // The bridge's listener pipes getLabelData() into HaDiscovery.updateLabels,
            // which consumes all five sections. If save() ever stops including any of
            // them in the emit payload, HA entity area assignments / type overrides /
            // explicit unique-id-suffixes / exclusion lists silently stop applying on
            // edit. Lock the full contract here.
            const loader = new LabelLoader(labelFile);
            const events = [];
            loader.on('labels-changed', (labelData) => events.push(labelData));

            loader.save({
                version: 1,
                labels: { '254/56/10': 'Kitchen' },
                type_overrides: { '254/203/15': 'cover' },
                entity_ids: { '254/56/10': 'kitchen_main' },
                exclude: ['254/56/250'],
                areas: { '254/56/10': 'Kitchen', '254/56/11': 'Hallway' }
            });

            expect(events.length).toBe(1);
            const payload = events[0];
            expect(payload.labels.get('254/56/10')).toBe('Kitchen');
            expect(payload.typeOverrides.get('254/203/15')).toBe('cover');
            expect(payload.entityIds.get('254/56/10')).toBe('kitchen_main');
            expect(payload.exclude.has('254/56/250')).toBe(true);
            expect(payload.areas.get('254/56/10')).toBe('Kitchen');
            expect(payload.areas.get('254/56/11')).toBe('Hallway');
        });
    });

    describe('getLabelsObject', () => {
        it('should return a plain object representation', () => {
            const data = { version: 1, labels: { '254/56/10': 'A', '254/56/11': 'B' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getLabelsObject()).toEqual({ '254/56/10': 'A', '254/56/11': 'B' });
        });
    });

    describe('extended label data (type_overrides, entity_ids, exclude)', () => {
        it('should load type_overrides from file', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                type_overrides: { '254/56/0': 'cover', '254/56/6': 'switch' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getTypeOverrides().get('254/56/0')).toBe('cover');
            expect(loader.getTypeOverrides().get('254/56/6')).toBe('switch');
            expect(loader.getTypeOverrides().size).toBe(2);
        });

        it('should load entity_ids from file', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                entity_ids: { '254/56/4': 'mainbedroom', '254/56/0': 'mainbedsouthblind' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getEntityIds().get('254/56/4')).toBe('mainbedroom');
            expect(loader.getEntityIds().size).toBe(2);
        });

        it('should load exclude list from file', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                exclude: ['254/56/255', '254/56/50', '254/56/66']
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getExcludeSet().has('254/56/255')).toBe(true);
            expect(loader.getExcludeSet().has('254/56/50')).toBe(true);
            expect(loader.getExcludeSet().size).toBe(3);
        });

        it('should return empty collections when extended sections are missing', () => {
            const data = { version: 1, labels: { '254/56/4': 'Test' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getTypeOverrides().size).toBe(0);
            expect(loader.getEntityIds().size).toBe(0);
            expect(loader.getExcludeSet().size).toBe(0);
        });

        it('should return all data via getLabelData()', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                type_overrides: { '254/56/0': 'cover' },
                entity_ids: { '254/56/4': 'mainbedroom' },
                exclude: ['254/56/255']
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            const ld = loader.getLabelData();

            expect(ld.labels).toBeInstanceOf(Map);
            expect(ld.typeOverrides).toBeInstanceOf(Map);
            expect(ld.entityIds).toBeInstanceOf(Map);
            expect(ld.exclude).toBeInstanceOf(Set);
            expect(ld.labels.get('254/56/4')).toBe('Main Bedroom');
            expect(ld.typeOverrides.get('254/56/0')).toBe('cover');
            expect(ld.entityIds.get('254/56/4')).toBe('mainbedroom');
            expect(ld.exclude.has('254/56/255')).toBe(true);
        });

        it('should return all sections via getFullData()', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                type_overrides: { '254/56/0': 'cover' },
                entity_ids: { '254/56/4': 'mainbedroom' },
                exclude: ['254/56/255']
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            const full = loader.getFullData();

            expect(full.labels).toEqual({ '254/56/4': 'Main Bedroom' });
            expect(full.type_overrides).toEqual({ '254/56/0': 'cover' });
            expect(full.entity_ids).toEqual({ '254/56/4': 'mainbedroom' });
            expect(full.exclude).toEqual(['254/56/255']);
        });

        it('should preserve extended sections through save()', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                type_overrides: { '254/56/0': 'cover' },
                entity_ids: { '254/56/4': 'mainbedroom' },
                exclude: ['254/56/255']
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            // Save only labels -- extended sections should be preserved
            loader.save({ '254/56/4': 'Updated Name' });

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.labels['254/56/4']).toBe('Updated Name');
            expect(saved.type_overrides).toEqual({ '254/56/0': 'cover' });
            expect(saved.entity_ids).toEqual({ '254/56/4': 'mainbedroom' });
            expect(saved.exclude).toEqual(['254/56/255']);
        });

        it('should update extended sections when saved as full file data', () => {
            const loader = new LabelLoader(labelFile);
            loader.save({
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                type_overrides: { '254/56/0': 'cover', '254/56/6': 'switch' },
                entity_ids: { '254/56/4': 'mainbedroom' },
                exclude: ['254/56/255']
            });

            expect(loader.getTypeOverrides().get('254/56/0')).toBe('cover');
            expect(loader.getTypeOverrides().get('254/56/6')).toBe('switch');
            expect(loader.getEntityIds().get('254/56/4')).toBe('mainbedroom');
            expect(loader.getExcludeSet().has('254/56/255')).toBe(true);
        });

        it('should load areas from file', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom', '254/56/10': 'Kitchen Light' },
                areas: { '254/56/4': 'Main Bedroom', '254/56/10': 'Kitchen' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getAreas().get('254/56/4')).toBe('Main Bedroom');
            expect(loader.getAreas().get('254/56/10')).toBe('Kitchen');
            expect(loader.getAreas().size).toBe(2);
        });

        it('should return empty areas map when areas section is missing', () => {
            const data = { version: 1, labels: { '254/56/4': 'Test' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            expect(loader.getAreas().size).toBe(0);
        });

        it('should include areas in getLabelData()', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                areas: { '254/56/4': 'Master Suite' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            const ld = loader.getLabelData();

            expect(ld.areas).toBeInstanceOf(Map);
            expect(ld.areas.get('254/56/4')).toBe('Master Suite');
        });

        it('should save areas to labels.json', () => {
            const loader = new LabelLoader(labelFile);
            loader.save({
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                areas: { '254/56/4': 'Upstairs' }
            });

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.areas).toEqual({ '254/56/4': 'Upstairs' });
        });

        it('should preserve areas through save() when only labels are passed', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                areas: { '254/56/4': 'Upstairs' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();

            // Save only labels — areas should be preserved
            loader.save({ '254/56/4': 'Updated Name' });

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.labels['254/56/4']).toBe('Updated Name');
            expect(saved.areas).toEqual({ '254/56/4': 'Upstairs' });
        });

        it('should include areas in getFullData()', () => {
            const data = {
                version: 1,
                labels: { '254/56/4': 'Main Bedroom' },
                areas: { '254/56/4': 'Upstairs' }
            };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            const full = loader.getFullData();

            expect(full.areas).toEqual({ '254/56/4': 'Upstairs' });
        });
    });

    describe('watch / hot-reload', () => {
        it('should emit labels-changed when the file is modified', (done) => {
            const data = { version: 1, labels: { '254/56/10': 'Original' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            loader.watch();

            loader.on('labels-changed', (labelData) => {
                expect(labelData.labels.get('254/56/10')).toBe('Updated');
                loader.unwatch();
                done();
            });

            // Modify the file after a small delay
            setTimeout(() => {
                const updated = { version: 1, labels: { '254/56/10': 'Updated' } };
                fs.writeFileSync(labelFile, JSON.stringify(updated));
            }, 100);
        }, 5000);

        it('save() emits labels-changed exactly once even with the watcher running (no double-fire)', (done) => {
            // The watcher's SELF_WRITE_GRACE_MS exists to prevent a SECOND
            // labels-changed firing from the fs.watch callback after our own
            // write. The FIRST emit comes from save() directly so the in-
            // process listeners (HA Discovery refresh, web UI SSE) wake up.
            const data = { version: 1, labels: { '254/56/10': 'Init' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            loader.watch();

            const handler = jest.fn();
            loader.on('labels-changed', handler);

            loader.save({ '254/56/10': 'Via Save' });

            // Wait longer than debounce (500ms) and longer than grace (1000ms)
            // to confirm only the direct emit fired, not the file-watcher path.
            setTimeout(() => {
                expect(handler).toHaveBeenCalledTimes(1);
                expect(handler.mock.calls[0][0].labels.get('254/56/10')).toBe('Via Save');
                loader.unwatch();
                done();
            }, 1500);
        }, 5000);

        it('should do nothing when no file path is configured', () => {
            const loader = new LabelLoader(null);
            loader.watch(); // should not throw
            loader.unwatch();
        });
    });
});
