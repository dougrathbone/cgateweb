const { isOptional, validateAddonConfig } = require('../tools/validate-addon-config');

describe('validate-addon-config', () => {
    describe('isOptional', () => {
        it('treats scalar types ending in ? as optional', () => {
            expect(isOptional('int(1,255)?')).toBe(true);
            expect(isOptional('str?')).toBe(true);
            expect(isOptional('bool?')).toBe(true);
        });

        it('treats scalar types without ? as required', () => {
            expect(isOptional('str')).toBe(false);
            expect(isOptional('list(remote|managed)')).toBe(false);
        });

        it('treats device selector types ending in ? as optional', () => {
            expect(isOptional('device?')).toBe(true);
            expect(isOptional('device(subsystem=tty)?')).toBe(true);
        });

        it('treats device selector types without ? as required', () => {
            expect(isOptional('device')).toBe(false);
            expect(isOptional('device(subsystem=tty)')).toBe(false);
        });

        it('treats array and object-list schemas as required (not optional)', () => {
            expect(isOptional(['int(1,255)'])).toBe(false);
            expect(isOptional([{ app_id: 'str', period_sec: 'int(0,86400)' }])).toBe(false);
        });
    });

    describe('validateAddonConfig', () => {
        it('passes when every required field has an options default and no orphans exist', () => {
            const config = {
                schema: {
                    cgate_host: 'str',
                    cgate_port: 'int(1,65535)?',
                    getall_networks: ['int(1,255)'],
                },
                options: {
                    cgate_host: '',
                    getall_networks: [254],
                },
            };
            expect(validateAddonConfig(config)).toEqual([]);
        });

        it('flags a required scalar missing from options', () => {
            const config = {
                schema: { cgate_host: 'str' },
                options: {},
            };
            const errors = validateAddonConfig(config);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('cgate_host');
            expect(errors[0]).toContain('Missing option');
        });

        it('flags an array field missing from options (arrays cannot be optional)', () => {
            const config = {
                schema: { getall_networks: ['int(1,255)'] },
                options: {},
            };
            const errors = validateAddonConfig(config);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('array/object-list');
        });

        it('does not flag an optional scalar missing from options', () => {
            const config = {
                schema: { cgate_port: 'int(1,65535)?' },
                options: {},
            };
            expect(validateAddonConfig(config)).toEqual([]);
        });

        it('does not flag an optional device selector missing from options', () => {
            // cgate_serial_device uses "device(subsystem=tty)?" and is
            // deliberately absent from options (hidden, opt-in).
            const config = {
                schema: { cgate_serial_device: 'device(subsystem=tty)?' },
                options: {},
            };
            expect(validateAddonConfig(config)).toEqual([]);
        });

        it('flags an orphan option with no schema entry', () => {
            const config = {
                schema: {},
                options: { mystery_field: true },
            };
            const errors = validateAddonConfig(config);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('mystery_field');
            expect(errors[0]).toContain('no matching schema entry');
        });

        it('reports multiple violations at once', () => {
            const config = {
                schema: { a: 'str', b: ['int(1,255)'] },
                options: { c: 1 },
            };
            // a missing, b missing, c orphan
            expect(validateAddonConfig(config)).toHaveLength(3);
        });
    });
});
