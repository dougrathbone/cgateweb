# AGENT.md - cgateweb Documentation

**cgateweb** is a Node.js MQTT bridge connecting Clipsal C-Bus automation systems to Home Assistant via MQTT.

## Commands
- `npm test` - Run all tests | `npm test -- tests/specific.test.js` - Single test
- `npm run test:coverage` - Coverage report | `npm run test:watch` - Watch mode
- `npm run lint` - ESLint (`--max-warnings 0`) | `npm run typecheck` - TypeScript check (`tsc --noEmit`)
- `npm start` - Run application | `npm run dev:debug` - Debug mode
- `npm run setup` - Create settings.js | `npm run validate-settings` - Validate config

## Testing Requirements
**⚠️ CRITICAL**: Before ANY commit, you MUST run all three CI gates and ensure they pass:
1. `npm test` - execute the full test suite (all tests must pass)
2. `npm run lint` - ESLint with zero warnings allowed
3. `npm run typecheck` - TypeScript check. CI installs the typescript version pinned in `package-lock.json` (stricter than a stale local `node_modules` — when in doubt, `npm ci` first). Files with `// @ts-check` are checked even though `tsconfig` has `checkJs: false`.
4. Only then proceed with commits or further changes
5. Console warnings during tests are expected from error condition testing

## Architecture
**Core**: CgateWebBridge (orchestrator), CgateConnectionPool (telnet pool), MqttManager (MQTT), HADiscovery (Home Assistant)
**Dirs**: `src/` (source), `tests/` (Jest tests), `settings.js` (config), `index.js` (entry)
**Pattern**: Event-driven with connection pooling, throttled queues, exponential backoff reconnection

## Code Style (CommonJS Node.js)
**Imports**: `const { Module } = require('./path')` | **Classes**: PascalCase | **Variables**: camelCase  
**Private**: `_methodName` | **Constants**: SCREAMING_SNAKE_CASE | **Files**: camelCase.js
**Errors**: Use `createErrorHandler(component)` for standardized error handling with context
**Testing**: Jest with mocks, ALL tests pass - run `npm test` after EVERY change to ensure no regressions
**Linting**: `npm run lint` (ESLint configured) | `npm run lint:fix` for auto-fixes
**Documentation**: JSDoc comments added to core functions, see `docs/CBUS_PROTOCOL.md` for C-Bus specifics

## Git Guidelines
**IMPORTANT**: Before making any source code commits, you MUST run `npm test`, `npm run lint`, and `npm run typecheck`, and ensure all pass. No code should be committed with failing checks — CI runs the same three gates (plus `validate:addon-config` / `validate:translations` / `validate:schema-i18n` for add-on option changes; run those locally too when touching `homeassistant-addon/config.yaml` or translations).

**Commit Messages**: Do not mention "Amp", "Claude", or AI assistants in commit messages. Keep commit messages professional and focused on the technical changes being made.

## Changelog Format
`homeassistant-addon/CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) and is written for the person upgrading, not the developer. Every release entry MUST follow these rules:

1. Keep the skeleton: `## [x.y.z] - date` headers, sections in the order Added / Fixed / Changed / Removed / Security. Skip empty sections.
2. Lead each bullet with the user-visible outcome in plain words (bold the headline phrase), followed by at most one or two sentences of context or action required. One bullet per change; merge tiny related changes.
3. **No code formatting (no backticks) anywhere.** Refer to options, topics, files, and commands in plain words: "the Air Conditioning control option", "the source_unit topic", "your settings file", "the project database in the share folder". Where a literal name is unavoidable, write it as plain text without backticks — but prefer description over literal names.
4. **No internal implementation detail**: no function names, repo file paths, bit layouts, C-Gate response codes, spec section numbers, or commit mechanics. Translate mechanism into user-visible behavior.
5. Issue references stay, in the form "(#28)" at the end of the bullet's first sentence.
6. Internal-only changes (refactors, CI, test work, dependency bumps) go in a single short "Internal:" bullet, or are omitted if invisible to users.

Good: "**Changing the temperature of an off thermostat no longer turns it on.** Adjusting the target on an off climate card used to start the plant; the command is now ignored with a warning."
Bad: "Fixed `_sendAirconSetpoint` fallback `HVAC_CODE_BY_MODE.heat` when `modeRaw === 0` (`mqttCommandRouter.js:699`)."

## Home Assistant Add-on Development
**Branch**: `develop/homeassistant` - Contains HA add-on development work
**Directory**: `homeassistant-addon/` - Contains add-on files (config.yaml, Dockerfile, run.sh, DOCS.md)
**Key Components**:
- `src/config/EnvironmentDetector.js` - Detects installation environment (standalone vs HA add-on)
- `src/config/ConfigLoader.js` - Loads config from settings.js OR /data/options.json
- Dual configuration system supports both standalone and HA add-on installations
**Testing**: Add-on development includes comprehensive tests for environment detection and configuration loading
**Documentation**: See `docs/project-homeassistant-addon.md` for implementation plan and `docs/setup-addon-distribution.md` for distribution setup

## CLAUDE.md Rules
**IMPORTANT**: Before making any source code commits, you MUST run `npm test`, `npm run lint`, and `npm run typecheck`, and ensure all pass. No code should be committed with failing checks.
