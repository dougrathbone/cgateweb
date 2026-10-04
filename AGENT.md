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

**Replies to users (GitHub issues, PR comments, PR reviews)**: Very concise. Plain text - no markdown, no bold, no bullets-as-decoration. Hyphens, never em dashes. Lead with the finding or the answer; cut the narration of how you got there. Ask for the one artefact you need rather than listing everything the user could send. Say plainly when a previous diagnosis of yours was wrong.

## Changelog Format
`homeassistant-addon/CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) and is written for the person upgrading, not the developer. Releases before 1.22.0 stay in `homeassistant-addon/CHANGELOG-archive.md` and are not rewritten. `npm run validate:changelog` enforces this.

1. Headings are `## [x.y.z](https://github.com/dougrathbone/cgateweb/releases/tag/vx.y.z) - YYYY-MM-DD`, newest first. Use the add-on repository release URL only when the source repository has no GitHub release. A version that never reached the add-on repository has no requirement for a release link and starts with `**This version was not published.**` Name the later version that includes the changes, or say there was nothing user-facing and which version to install.
2. Sections, in this order, skipping empty ones: Breaking changes, Action required, Added, Fixed, Changed, Removed, Security.
3. Put upgrade steps and incompatible behaviour in Breaking changes or Action required, not further down the version.
4. Lead each bullet with the user-visible outcome in bold. One sentence. A second short sentence only when the reader must do something, or to distinguish a repeated symptom. When the same symptom was fixed before, name the earlier version and whether this is a new cause or a regression.
5. No backticks and no internal notes. Refer to options, topics, files, and commands in plain words. A release with nothing the user can see is one Changed bullet: "Maintenance release; no user-facing changes."
6. Issue references are full source-repository links at the end of the bullet, never a bare number.
7. About 30 words per bullet. The checker rejects anything past 40. No placeholders, empty sections, or third sentence. The how and the why belong in the issue or the commit.

Good: "**Key switches and bus couplers are now recognised.** With unit-type classification on, a group driven only by one becomes a binary sensor instead of a light. ([#37](https://github.com/dougrathbone/cgateweb/issues/37))"
Bad: "**Key-input switches and bus couplers are now recognised for unit-type classification** (#37). With "Set entity type from C-Bus unit type" on, a group driven only by a key-input wall switch (`KEY1`, `KEYB2`, `KEYB4`, `KEYGL5`, `KEYE1`–`KEYE4`) or a bus coupler (`BCN4B`) now becomes a `binary_sensor` instead of keeping the default light type and logging "unit types not recognised". Both families are input-only hardware that drives no load. Reported from a live showroom install."

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
