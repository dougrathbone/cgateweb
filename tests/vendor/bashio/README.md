# Vendored bashio (test-only)

`config.sh` and `jq.sh` are verbatim copies of:

- https://github.com/hassio-addons/bashio/blob/main/lib/config.sh
- https://github.com/hassio-addons/bashio/blob/main/lib/jq.sh

Copied from tag `v0.18.1` (commit `ac3781c227b2fd1de71f1f9240cbbfb8f27aa3cb`),
MIT-licensed -- see `LICENSE` in this directory (copyright Franck Nijhof).

## Why vendored

`tests/cgateAccessControl.test.js` has a suite that exercises
`_cgateweb_external_client_rules` (in
`homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh`) against
bashio's *real* `bashio::config` object-list flattening (the `key|length` /
`key[i].field` jq queries), rather than the hand-rolled
`EXTERNAL_RULES_STUB` used everywhere else in that file to test validation
logic in isolation. That needs `bashio::config` and `bashio::jq`'s actual
upstream implementation, shelling out to jq exactly as the add-on container
does.

These two files used to be reproduced inline inside a JS template literal in
the test file. That had two problems: embedding bash inside a JS template
literal forced `\$`-escaping every `${...}` reference, which repeatedly
tripped ESLint, and a hand-copied inline version can silently drift from
upstream with no way to `diff` it. Vendoring the actual files fixes both.

## Not modified, but not runnable in isolation either

These files are copied byte-for-byte from upstream and are not edited. They
are not sourced standalone in production -- real bashio also defines
`__BASHIO_EXIT_OK`/`__BASHIO_EXIT_NOK` (in bashio's `const.sh`) and
`bashio::log.trace`/`bashio::app.config` (elsewhere in bashio), which
`config.sh`/`jq.sh` alone reference but don't define. The test file supplies
minimal stand-ins for exactly those four names -- see
`REAL_BASHIO_CONFIG_STUB` in `tests/cgateAccessControl.test.js` -- rather
than vendoring the rest of the library, since nothing else here calls into
it.

`jq.sh`'s `bashio::jq` also expands `"${arguments[@]}"` for jq's optional
extra-args plumbing, which is empty in every call this test suite makes.
Expanding an empty array under `set -u` throws "unbound variable" on bash
3.2 (macOS's system `/bin/bash`) -- a real bug, fixed upstream in bash 4.4+.
GitHub Actions' `ubuntu-latest` runner ships a modern bash and is
unaffected. Rather than patch the vendored file to work around a bash 3.2
bug, the test relaxes `set -u` around the vendored calls only (see the
`set +u` comment next to where these files are sourced).
