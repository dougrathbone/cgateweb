# AGENT.md - cgateweb Documentation

**cgateweb** is a Node.js MQTT bridge connecting Clipsal C-Bus automation systems to Home Assistant via MQTT.

## Commands
- `npm test` - Run all tests | `npm test -- tests/specific.test.js` - Single test
- `npm run test:coverage` - Coverage report | `npm run test:watch` - Watch mode
- `npm start` - Run application | `npm run dev:debug` - Debug mode
- `npm run setup` - Create settings.js | `npm run validate-settings` - Validate config
- **No build/lint configured** - Add ESLint for code quality

## Testing Requirements
**⚠️ CRITICAL**: After ANY code change, you MUST:
1. Run `npm test` to execute the full test suite
2. Ensure ALL tests pass (364 total tests expected)
3. Only then proceed with commits or further changes
4. Console warnings during tests are expected from error condition testing

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
**IMPORTANT**: Before making any source code commits, you MUST run the full test suite (`npm test`) and ensure all tests pass. No code should be committed with failing tests. This ensures code quality and prevents regressions in the codebase.

**Commit Messages**: Do not mention "Amp", "Claude", or AI assistants in commit messages. Keep commit messages professional and focused on the technical changes being made.

## CLAUDE.md Rules
**IMPORTANT**: Before making any source code commits, you MUST run the full test suite (`npm test`) and ensure all tests pass. No code should be committed with failing tests. This ensures code quality and prevents regressions in the codebase.
