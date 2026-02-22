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

    describe('watch / hot-reload', () => {
        it('should emit labels-changed when the file is modified', (done) => {
            const data = { version: 1, labels: { '254/56/10': 'Original' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            loader.watch();

            loader.on('labels-changed', (newLabels) => {
                expect(newLabels.get('254/56/10')).toBe('Updated');
                loader.unwatch();
                done();
            });

            // Modify the file after a small delay
            setTimeout(() => {
                const updated = { version: 1, labels: { '254/56/10': 'Updated' } };
                fs.writeFileSync(labelFile, JSON.stringify(updated));
            }, 100);
        }, 5000);

        it('should not emit when file is written by save() within grace period', (done) => {
            const data = { version: 1, labels: { '254/56/10': 'Init' } };
            fs.writeFileSync(labelFile, JSON.stringify(data));

            const loader = new LabelLoader(labelFile);
            loader.load();
            loader.watch();

            const handler = jest.fn();
            loader.on('labels-changed', handler);

            // save() sets _lastSaveTime; fs.watch events within 1s grace are suppressed
            loader.save({ '254/56/10': 'Via Save' });

            // Wait longer than debounce (500ms) but within the grace period (1000ms)
            setTimeout(() => {
                expect(handler).not.toHaveBeenCalled();
                loader.unwatch();
                done();
            }, 800);
        }, 3000);

        it('should do nothing when no file path is configured', () => {
            const loader = new LabelLoader(null);
            loader.watch(); // should not throw
            loader.unwatch();
        });
    });
});
