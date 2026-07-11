'use strict';

const {
    isValidCgateProjectName,
    isValidCgateUsername,
    isValidCgatePassword
} = require('../../src/config/validationRules');

describe('validationRules C-Gate identifiers', () => {
    describe('isValidCgateProjectName', () => {
        it.each(['HOME', 'CLIPSAL', '5COGAN', 'My_Home', 'a', 'A1_b2'])(
            'accepts %s',
            (name) => expect(isValidCgateProjectName(name)).toBe(true)
        );

        it.each([
            '',
            'HO ME',
            'HOME/254',
            'HOME\\x',
            'HOME\nX',
            'HOME#x',
            'HOME"x',
            "HOME'x",
            'a'.repeat(33),
            null,
            123
        ])('rejects %j', (name) => expect(isValidCgateProjectName(name)).toBe(false));
    });

    describe('isValidCgateUsername', () => {
        it('accepts alphanumeric usernames', () => {
            expect(isValidCgateUsername('admin')).toBe(true);
            expect(isValidCgateUsername('user_1')).toBe(true);
        });

        it('rejects spaces and newlines', () => {
            expect(isValidCgateUsername('ad min')).toBe(false);
            expect(isValidCgateUsername('admin\nSHUTDOWN')).toBe(false);
        });
    });

    describe('isValidCgatePassword', () => {
        it('accepts printable ASCII without spaces', () => {
            expect(isValidCgatePassword('s3cret!')).toBe(true);
            expect(isValidCgatePassword('p@ss#word$')).toBe(true);
        });

        it('rejects spaces, newlines, and empty', () => {
            expect(isValidCgatePassword('')).toBe(false);
            expect(isValidCgatePassword('pass word')).toBe(false);
            expect(isValidCgatePassword('x\nSHUTDOWN\n')).toBe(false);
            expect(isValidCgatePassword('x\r\n')).toBe(false);
        });
    });
});
