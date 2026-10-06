const {
    parseCgateGreeting,
    isOlderThan,
    CgateVersionReporter,
    RECOMMENDED_CGATE_VERSION
} = require('../src/cgateVersion');

describe('parseCgateGreeting', () => {
    it.each([
        ['Service ready: Clipsal C-Gate Version: v3.3.2 (build 1855) #cmd-syntax=1.0', '3.3.2', '1855'],
        ['Service ready: Schneider Electric C-Gate Version: v3.3.2 (build 1855) #cmd-syntax=1.0', '3.3.2', '1855'],
        ['Service ready: Schneider Electric C-Gate Version: v3.8.0 (build 2405) #cmd-syntax=1.0', '3.8.0', '2405'],
        ['Service ready: Clipsal C-Gate Version: v2.11.8 (build 3282) #cmd-syntax=1.0', '2.11.8', '3282'],
        ['Service ready: C-Gate Version: v3.7 #cmd-syntax=1.0', '3.7', null]
    ])('reads %s', (greeting, version, build) => {
        expect(parseCgateGreeting(greeting)).toEqual({ version, build });
    });

    it.each([
        [''],
        [null],
        [undefined],
        ['OK.'],
        ['Service ready'],
        ['Service ready: C-Gate Version: unknown']
    ])('returns null for %p', (greeting) => {
        expect(parseCgateGreeting(greeting)).toBeNull();
    });
});

describe('isOlderThan', () => {
    it.each([
        ['3.3.2', '3.8.0', true],
        ['2.11.8', '3.8.0', true],
        ['3.7.1', '3.8.0', true],
        ['3.7', '3.8.0', true],
        ['3.8.0', '3.8.0', false],
        ['3.8', '3.8.0', false],
        ['3.8.1', '3.8.0', false],
        ['3.10.0', '3.8.0', false],
        ['4.0.0', '3.8.0', false]
    ])('%s older than %s is %s', (version, minimum, expected) => {
        expect(isOlderThan(version, minimum)).toBe(expected);
    });

    it('treats an unparseable version as not older', () => {
        expect(isOlderThan('', '3.8.0')).toBe(false);
        expect(isOlderThan('abc', '3.8.0')).toBe(false);
    });
});

describe('CgateVersionReporter', () => {
    const OLD = 'Service ready: Clipsal C-Gate Version: v3.3.2 (build 1855) #cmd-syntax=1.0';
    const NEW = 'Service ready: Schneider Electric C-Gate Version: v3.8.0 (build 2405) #cmd-syntax=1.0';
    let logger;

    beforeEach(() => {
        logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    });

    it('recommends 3.8.0', () => {
        expect(RECOMMENDED_CGATE_VERSION).toBe('3.8.0');
    });

    it('logs the version and warns once for an older C-Gate', () => {
        const reporter = new CgateVersionReporter({ settings: {}, logger });

        reporter.handleGreeting(OLD);

        expect(logger.info).toHaveBeenCalledWith('C-Gate version 3.3.2 (build 1855)');
        expect(logger.warn).toHaveBeenCalledTimes(1);
        const warning = logger.warn.mock.calls[0][0];
        expect(warning).toContain('C-Gate 3.3.2 is older than 3.8.0');
        expect(warning).toContain('some features may be unsupported');
        expect(reporter.version).toBe('3.3.2');
    });

    it('stays quiet when every pool connection reports the same version', () => {
        const reporter = new CgateVersionReporter({ settings: {}, logger });

        reporter.handleGreeting(OLD);
        reporter.handleGreeting(OLD);
        reporter.handleGreeting(OLD);

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('does not warn for 3.8.0', () => {
        const reporter = new CgateVersionReporter({ settings: {}, logger });

        reporter.handleGreeting(NEW);

        expect(logger.info).toHaveBeenCalledWith('C-Gate version 3.8.0 (build 2405)');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('reports again when C-Gate comes back as a different version', () => {
        const reporter = new CgateVersionReporter({ settings: {}, logger });

        reporter.handleGreeting(OLD);
        reporter.handleGreeting(NEW);

        expect(logger.info).toHaveBeenCalledTimes(2);
        expect(logger.info).toHaveBeenLastCalledWith('C-Gate version 3.8.0 (build 2405)');
        expect(reporter.version).toBe('3.8.0');
    });

    it('tells managed-mode users how to upgrade', () => {
        const reporter = new CgateVersionReporter({ settings: { cgate_mode: 'managed' }, logger });

        reporter.handleGreeting(OLD);

        expect(logger.warn.mock.calls[0][0]).toContain('/share/cgate/');
    });

    it('does not mention the add-on share folder in remote mode', () => {
        const reporter = new CgateVersionReporter({ settings: { cgate_mode: 'remote' }, logger });

        reporter.handleGreeting(OLD);

        expect(logger.warn.mock.calls[0][0]).not.toContain('/share/cgate/');
    });

    it('ignores greetings it cannot read', () => {
        const reporter = new CgateVersionReporter({ settings: {}, logger });

        reporter.handleGreeting('OK.');

        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(reporter.version).toBeNull();
    });
});
