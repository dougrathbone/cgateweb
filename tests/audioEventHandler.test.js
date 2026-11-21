const AudioEventHandler = require('../src/audioEventHandler');

function makeHandler() {
    const logger = { info: jest.fn(), debug: jest.fn() };
    const captureRaw = jest.fn();
    return { handler: new AudioEventHandler({ logger, captureRaw }), logger, captureRaw };
}

describe('AudioEventHandler', () => {
    it.each([
        'audio current_feed //PROJ/254/205 1 2 4 100',
        'audio mute //PROJ/254/205 0 7 2 #sourceunit=9 OID=',
        '#s# audio on //PROJ/254/205 1 0 255',
        '# audio set_feed //PROJ/254/205 1 3 2 0',
        'mediatransport pause //PROJ/254/192 1 #sourceunit=4',
        '#e# mediatransport status //PROJ/254/192 1',
    ])('consumes and captures %s', (line) => {
        const { handler, captureRaw } = makeHandler();
        expect(handler.handleLine(line)).toBe(true);
        expect(captureRaw).toHaveBeenCalledWith(line);
    });

    it.each([
        'lighting on 254/56/4',
        'clock time //PROJ/254/223 21:13:21 0',
        'audiofoo //PROJ/254/205 1',
        'security zone_unsealed //PROJ/254/208 3',
        '',
    ])('leaves %p to the other handlers', (line) => {
        const { handler, captureRaw } = makeHandler();
        expect(handler.handleLine(line)).toBe(false);
        expect(captureRaw).not.toHaveBeenCalled();
    });

    it('explains how to capture once per application, not once per line', () => {
        const { handler, logger } = makeHandler();
        handler.handleLine('audio mute //PROJ/254/205 1 2 7');
        handler.handleLine('audio mute //PROJ/254/205 1 3 7');
        handler.handleLine('mediatransport play //PROJ/254/192 1');
        handler.handleLine('mediatransport stop //PROJ/254/192 1');

        expect(logger.info).toHaveBeenCalledTimes(2);
        expect(logger.info.mock.calls[0][0]).toContain('cbus_raw_event_log_apps');
        expect(logger.info.mock.calls[0][0]).toContain('205');
        expect(logger.info.mock.calls[1][0]).toContain('192');
    });
});
