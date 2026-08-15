// @ts-check
'use strict';

/*
 * cgate-client/project — C-Bus project file parsing, kept off the transport path.
 *
 * WHAT THIS IS
 * A re-export barrel over src/cbusProjectParser.js. It moves no code and
 * changes no behaviour. It exists as a SEPARATE entry point from
 * ./cgate-client so that the parser's heavy dependencies (adm-zip, sql.js,
 * xml2js) are only loaded by a consumer that actually wants to read a Toolkit
 * export. A client that just talks to C-Gate over TCP should never pay for a
 * WebAssembly SQLite build.
 *
 * IMPORT PURITY IS THE CONTRACT
 * Requiring this file MUST NOT read configuration, touch the filesystem
 * looking for settings, probe the current working directory, write to stdout
 * or stderr, or register timers, sockets or process handlers — a consumer must
 * not inherit cgateweb's config loading simply by importing it. Note that
 * sql.js is loaded lazily inside the parser at call time, not at require time,
 * which is what keeps this barrel cheap as well as pure.
 * tests/cgateClientBarrel.test.js enforces the rule from a child process with
 * a working directory that contains no settings.js.
 *
 * LONG TERM
 * The intent is to extract this, alongside ./cgate-client, into a real
 * published `cgate-client` package. Treat the export list below as public API.
 */

const CbusProjectParser = require('../cbusProjectParser');

module.exports = {
    CbusProjectParser
};
