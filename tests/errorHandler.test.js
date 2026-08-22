'use strict';

const { createErrorHandler } = require('../src/errorHandler');

describe('ErrorHandler', () => {
    let handler;
    let loggerErrorSpy;
    let exitSpy;

    beforeEach(() => {
        handler = createErrorHandler('test-component');
        loggerErrorSpy = jest.spyOn(handler.logger, 'error').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterEach(() => {
        loggerErrorSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('logs error with context and action', () => {
        const error = new Error('boom');
        error.name = 'TypeError';

        handler.handle(error, { topic: 'cbus/write/1' }, 'publish', false);

        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Error during publish:',
            expect.objectContaining({
                component: 'test-component',
                action: 'publish',
                errorName: 'TypeError',
                errorMessage: 'boom',
                topic: 'cbus/write/1',
                stack: error.stack
            })
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('treats missing action as a generic occurrence (non-fatal)', () => {
        const error = new Error('oops');

        handler.handle(error, { attempt: 2 }, null, false);

        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Error occurred:',
            expect.objectContaining({
                component: 'test-component',
                action: null,
                errorMessage: 'oops',
                attempt: 2
            })
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('defaults context to {} and action to null when omitted', () => {
        const error = new Error('minimal');

        handler.handle(error);

        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Error occurred:',
            expect.objectContaining({
                component: 'test-component',
                action: null,
                errorMessage: 'minimal'
            })
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits the process on fatal errors', () => {
        const error = new Error('fatal');

        handler.handle(error, { phase: 'startup' }, 'connect', true);

        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Error during connect:',
            expect.objectContaining({
                phase: 'startup',
                action: 'connect'
            })
        );
        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Fatal error detected, terminating process',
            { component: 'test-component' }
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
