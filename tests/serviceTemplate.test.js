const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'cgateweb.service.template');

// The existing installer tests mock fs and child_process wholesale and assert
// on call ordering, which is why three unit-content bugs survived inside 75%
// statement coverage: a hardcoded /usr/bin/node that fails 203/EXEC under nvm,
// a ProtectHome that makes an install under /home fail 200/CHDIR, and a
// Requires=network.target that starts the service before the network routes.
// These tests render the template the way the installer does and assert on the
// result, which is the level those bugs live at.
describe('cgateweb.service.template', () => {
    const template = fs.readFileSync(TEMPLATE, 'utf8');

    /** Mirror of the installer's substitution, so the assertions describe a real unit. */
    function render({ installPath = '/opt/cgateweb', nodeBin = '/usr/local/bin/node' } = {}) {
        const underHome = installPath === '/home' || installPath.startsWith('/home/');
        return template
            .replace(/%I/g, installPath)
            .replace(/%NODE%/g, nodeBin)
            .replace(/%PROTECT_HOME%/g, underHome ? 'no' : 'yes');
    }

    it('leaves no placeholder unsubstituted', () => {
        const unit = render();
        expect(unit).not.toMatch(/%I\b/);
        expect(unit).not.toMatch(/%NODE%/);
        expect(unit).not.toMatch(/%PROTECT_HOME%/);
    });

    it('runs the node binary it was given rather than a hardcoded path', () => {
        // Under nvm/fnm/asdf - the usual way to get a supported Node on Debian
        // or a Pi - /usr/bin/node is absent or too old, and the installer's
        // version check passes on a different binary entirely.
        const unit = render({ nodeBin: '/home/pi/.nvm/versions/node/v22.13.0/bin/node' });
        expect(unit).toContain('ExecStart=/home/pi/.nvm/versions/node/v22.13.0/bin/node /opt/cgateweb/index.js');
        // Assert on the directive, not the whole file - the template's own
        // comment mentions /usr/bin/node to explain why it is not used.
        const execStart = unit.split('\n').find(l => l.startsWith('ExecStart='));
        expect(execStart).not.toContain('/usr/bin/node');
    });

    it('keeps ProtectHome on for an install outside /home', () => {
        expect(render({ installPath: '/opt/cgateweb' })).toContain('ProtectHome=yes');
    });

    it.each([
        ['/home/pi/cgateweb'],
        ['/home/doug/code/cgateweb'],
        ['/home']
    ])('disables ProtectHome for %s, which it would otherwise be unable to chdir into', (installPath) => {
        const unit = render({ installPath });
        expect(unit).toContain('ProtectHome=no');
        // The contradiction this guards: WorkingDirectory under a hidden /home.
        expect(unit).toContain(`WorkingDirectory=${installPath}`);
    });

    it('waits for the network to be configured, not merely for the target to exist', () => {
        const unit = render();
        // network.target is reached before any interface is up; a service that
        // dials out wants network-online.target.
        expect(unit).toContain('After=network-online.target');
        expect(unit).toContain('Wants=cgate.service network-online.target');
        expect(unit).not.toMatch(/^Requires=network\.target$/m);
    });

    it('wires reload to SIGUSR1, which is what index.js listens for', () => {
        expect(render()).toContain('ExecReload=/bin/kill -USR1 $MAINPID');
    });

    it('can write to its own install directory', () => {
        const unit = render({ installPath: '/opt/cgateweb' });
        // ProtectSystem=strict makes the whole filesystem read-only, so the
        // install path has to be granted back explicitly.
        expect(unit).toContain('ProtectSystem=strict');
        expect(unit).toContain('ReadWritePaths=/opt/cgateweb');
    });

    it('keeps the hardening directives that do not conflict with running', () => {
        const unit = render();
        for (const directive of [
            'NoNewPrivileges=yes',
            'PrivateTmp=yes',
            'ProtectKernelTunables=yes',
            'ProtectKernelModules=yes',
            'ProtectControlGroups=yes',
            'RestrictSUIDSGID=yes',
            'CapabilityBoundingSet='
        ]) {
            expect(unit).toContain(directive);
        }
    });

    it('runs as the dedicated service user and group the installer creates', () => {
        const unit = render();
        expect(unit).toContain('User=cgateweb');
        expect(unit).toContain('Group=cgateweb');
    });
});
