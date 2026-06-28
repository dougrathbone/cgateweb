# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cgateweb is a Node.js MQTT bridge for C-Bus lighting systems that connects to C-Gate over TCP and publishes events to an MQTT broker. It supports Home Assistant MQTT Discovery for automatic device configuration.

## Development Commands

- **Start application**: `npm start` or `node index.js`
- **Run tests**: `npm test`
- **Run tests with coverage**: `npm test -- --coverage`
- **Install dependencies**: `npm install`

## Development Guidelines

**IMPORTANT**: Before making any source code commits, you MUST run the full test suite (`npm test`) and ensure all tests pass. No code should be committed with failing tests. This ensures code quality and prevents regressions in the codebase.

## Releasing / Home Assistant Add-on Distribution

This project uses a **two-repository model** for Home Assistant add-on distribution:

- **Source repo** (this repo): `dougrathbone/cgateweb` -- contains all source code, tests, and the add-on packaging under `homeassistant-addon/`.
- **Distribution repo**: `dougrathbone/cgateweb-homeassistant` -- the HA add-on repository that users add to Home Assistant. HA Supervisor checks this repo for version updates.

A GitHub Actions workflow (`.github/workflows/hacs-distribution.yml`) syncs code from this repo to the distribution repo. **It only triggers on git tag pushes matching `v*`** (or manual `workflow_dispatch`).

### Version bump and release process

When bumping the version (e.g., for a bug fix or feature release), you MUST:

1. Update the version in **both** `package.json` and `homeassistant-addon/config.yaml` (keep them in sync).
2. Commit and push the version bump.
3. **Create and push a git tag** matching the version: `git tag v<version> && git push origin v<version>` (e.g., `git tag v1.4.7 && git push origin v1.4.7`).

If you skip step 3, the distribution repo will NOT be updated, Home Assistant will not see the new version, and the add-on will not auto-update on user devices. This has caused stale deployments in the past.

CI now enforces step 1: the `version-sync` job in `.github/workflows/ci.yml` fails the build if `package.json` and `homeassistant-addon/config.yaml` disagree. Do not edit one without the other.

After tagging, backfill a GitHub Release on the source repo (`gh release create vX.Y.Z --notes "..."`) so the source-repo release page stays in lockstep with the distribution. The `hacs-distribution.yml` workflow only creates a Release on the **distribution** repo, not the source.

### Home Assistant Add-on config.yaml Rules

When modifying `homeassistant-addon/config.yaml`, follow these rules to prevent upgrade failures:

1. **Array-type schema fields MUST have defaults in `options`**. HA Supervisor validates that all non-optional schema fields exist in the user's saved config. If you remove an array field from `options`, users upgrading from older versions will get "Missing option" validation errors because their saved config won't have the field. This includes both simple arrays (`["int(1,255)"]`) and complex object lists.

2. **Never remove a field from `options` unless its schema type ends with `?`** (optional). Only scalar fields with the `?` suffix (e.g., `"int(1,255)?"`, `"str?"`, `"bool?"`) can safely be omitted from `options`. Array and object list schemas cannot use `?`.

3. **Test upgrade compatibility** before releasing config.yaml changes: verify that a user with the OLD config.yaml's `options` values saved in their HA instance can successfully upgrade to the NEW config.yaml without validation errors.

## Architecture

### Core Components

- **index.js**: Main application entry point containing connection management, settings loading, C-Gate communication, MQTT handling, and Home Assistant discovery
- **settings.js**: Configuration file containing C-Gate server details, MQTT broker settings, and Home Assistant discovery options
- **install-service.js**: Systemd service installer for Linux deployment

### Key Architecture Patterns

- **Event-driven architecture**: Uses Node.js EventEmitter for handling C-Gate events and MQTT messages
- **Throttled message queue**: Implements message throttling to prevent overwhelming C-Gate with commands
- **Exponential backoff**: Connection retry logic with exponential backoff for resilient connectivity
- **Parser classes**: Dedicated parsing logic for C-Gate events and commands (CBusEvent, CBusCommand)

### Connection Management

The application uses optimized connection architecture:

#### Connection Pool (Commands)
- **Connection pool** (default port 20023): Pool of persistent TCP connections for C-Gate commands
- **Pool size**: Configurable (default: 3 connections)
- **Performance**: 50-80% faster command execution by eliminating connection setup overhead
- **Load balancing**: Round-robin distribution across healthy connections
- **Health monitoring**: Automatic health checks and failover
- **Keep-alive**: Periodic pings to maintain connection health

#### Event Connection (Single)
- **Event connection** (default port 20025): Single TCP connection for receiving real-time events
- Remains singular due to broadcast nature of C-Gate events

#### Connection Features
- **Automatic reconnection**: Exponential backoff with configurable retry limits
- **SSL/TLS support**: Experimental support for secure connections
- **Connection monitoring**: Real-time health tracking and reporting
- **Error handling**: Comprehensive error recovery and logging

### MQTT Topic Structure

- **Read topics**: `cbus/read/{network}/{app}/{group}/state|level`
- **Write topics**: `cbus/write/{network}/{app}/{group}/switch|ramp`
- **Control topics**: `cbus/write/{network}/{app}//getall`, `cbus/write/{network}///tree`
- **Status topic**: `hello/cgateweb` (Online/Offline with LWT)

### Home Assistant Discovery

Supports automatic discovery of C-Bus devices:
- **Lights**: Application 56 (Lighting) as light entities
- **Covers**: Configurable app ID as cover entities  
- **Switches/Relays/PIR**: Configurable app IDs as switch/binary_sensor entities
- Uses MQTT Discovery protocol with configurable prefix (default: `homeassistant`)

### Home Assistant Add-on Translations

The add-on configuration UI is translated into 17 languages via YAML files in `homeassistant-addon/translations/`. Each file contains translated `name` and `description` fields for all configuration options while keeping YAML keys and technical terms (C-Gate, C-Bus, MQTT, etc.) in English. Supported languages: en, de, es, fr, it, nl, pt, ru, zh, ja, ko, pl, sv, no, da, cs, uk. New translations should be added by copying `en.yaml` and translating the user-facing strings.

**Adding or removing a config option means editing all 17 translation files, not just `en.yaml`.** The `validate:translations` CI gate (`tools/validate-translations.js`) enforces that every `translations/*.yaml` has the exact same option keys as `en.yaml`; adding a key to `en.yaml` alone fails the build (this happens in the "Validate add-on config & translations" job, which is easy to miss because `npm test` does not run it). Run `npm run validate:translations` and `npm run validate:addon-config` locally before pushing a config-option change. Keep technical terms (C-Gate, `/share/cgate`, zip, managed mode) in English in every language.

## Testing Standards

- Uses Jest testing framework
- Test files in `/tests` directory with `.test.js` suffix
- Follows Arrange-Act-Assert pattern
- Unit tests prioritized over integration tests
- Mock external dependencies (network, MQTT, timers)
- Run coverage reports to guide testing efforts

## Configuration

Settings are loaded from `settings.js` with fallback to defaults in `index.js`. Key configuration areas:
- C-Gate connection details (IP, ports, credentials)
- MQTT broker settings (host, credentials, retain flags)
- Home Assistant discovery settings (enabled apps, networks to scan)  
- Operational settings (logging, message intervals, reconnection delays)
- **Connection pool settings** (new performance optimization):
  - `connectionPoolSize`: Number of command connections (default: 3, min: 1)
  - `healthCheckInterval`: Health check frequency in ms (default: 30000, min: 5000)
  - `keepAliveInterval`: Keep-alive ping frequency in ms (default: 60000, min: 10000)
  - `connectionTimeout`: Connection establishment timeout in ms (default: 5000, min: 1000)
  - `maxRetries`: Maximum connection retry attempts (default: 3, min: 1)

## Error Handling

- Comprehensive error handling for network connections
- C-Gate error code parsing and logging
- MQTT connection resilience with LWT
- Settings validation on startup
- Graceful degradation when services are unavailable

## Code Review & Improvement Process

When the user asks to "review the codebase", "look for improvement opportunities", "what should we work on next", or anything similarly open-ended, do a **parallel-agent survey** rather than a sequential scan. The codebase is large enough (40+ test files, 30+ src modules) that a single-pass review either misses things or blows the context window.

### How to run a codebase review

Dispatch four Explore agents in parallel covering these angles:

1. **Code quality and refactor candidates**: largest/most complex files, oversized methods (>80 lines or >3 nesting levels), duplicated patterns across files, magic numbers/timeouts not pulled from `defaultSettings.js`, error-handling gaps, long parameter lists, architectural smells (e.g. parameters threaded through many methods that could be instance properties).
2. **Technical debt and security**: TODO/FIXME/HACK comments (note which are stale vs justified), dead code, debug leftovers (`console.log` in `src/`), security smells in `webServer.js` specifically (path traversal, unsafe deserialization, missing input validation, CORS gaps, rate-limit gaps), hardcoded credentials/paths, unused/transitive deps.
3. **Test coverage and quality**: per-module coverage, mock staleness (mocks of methods that no longer exist), test smells (mock-only assertions, multi-expect tests, skipped tests, long setups), gaps in critical paths (connection-pool exhaustion, CORS rejection, rate-limit enforcement, label hot-reload).
4. **Ops and build hygiene**: Dockerfile reproducibility (pinned digests, HEALTHCHECK, layer caching, root vs non-root), `cont-init.d` script strict-mode and ordering, GitHub Actions version pinning (SHA vs `@vX`), secrets exposure, version-sync enforcement, integration-test gating on releases, translation drift across 17 languages.

Tell each agent to return a **prioritized list (HIGH/MEDIUM/LOW) with file:line references**, and to **say so explicitly** if a category is clean rather than padding.

Synthesize their reports into 5-7 top opportunities ranked by (value / effort). Don't dump all findings - the user is looking for a steerable shortlist, not an audit. Lead with the items that close documented pain points or fix latent bugs; defer big architectural refactors for dedicated sessions unless the user explicitly opts in.

### Recurring patterns to look for in this codebase

These are the patterns that have actually shown up in past reviews. If you spot a new instance, flag it:

- **Magic numbers that should be in `src/defaultSettings.js`**. The pattern is hardcoded timeouts/limits/retry counts that ops on slow hardware or fragile networks would want to tune. New tunables should be additive (default = current value) so existing users see no behaviour change. The `haDiscoveryMaxTreeRetryAttempts`/`haDiscoveryTreeRetry*Ms`/`haDiscoveryTreeRequestTimeoutMs`/`webMaxBodySizeBytes` settings (added in 1.9.0) are the template.
- **Exponential-backoff formulas reinvented per file**. Use `src/backoff.js`'s `backoffDelay(retryNumber, { initialMs, maxMs, jitter })` rather than rolling another `Math.min(initial * Math.pow(2, n), max)`.
- **Long positional parameter lists threading state through helper chains** (the `labelSnapshot` smell). If the parameter is conceptually a property of the operation rather than a per-call input, lift it to an instance property scoped to the operation and clear it at the end. Safe because the run is synchronous and JavaScript is single-threaded.
- **Async parse callbacks where state is cleared before the callback fires**. If `parseString` or similar can fail, the failure path needs a recovery route (e.g. via `_handleTreeRequestFailure`); don't just log and return, or the surrounding state machine will get stuck.
- **GitHub Actions pinned to floating tags** (`@v5`, `@v2`). Pin to commit SHA with a version comment. First-party `actions/*` and third-party both.
- **Secrets substituted into rendered `run:` commands**. Move them to `env:` so they cannot leak via verbose-mode logs.
- **`package.json` and `homeassistant-addon/config.yaml` version drift**. CI now enforces this, but if you see the check pass on a release that shouldn't be passing, double-check the version-sync logic in `ci.yml`.

### Process for executing on a multi-item improvement plan

When the user approves a batch of improvements:

1. Create one task per item via `TaskCreate` and track them.
2. Make **one commit per item** with a focused, narrative commit message (the "why", not just the "what"). Easier to review and easier to revert.
3. Order commits so risky/big items go **last** - small infrastructure changes first build confidence in the test suite and CI.
4. After all items are committed locally, push them as a batch and watch CI. The version bump goes in a separate `chore: release vX.Y.Z` commit at the end, with the CHANGELOG entry summarizing the batch.
5. Tag and push the tag - that triggers the HACS distribution workflow.
6. Backfill the source-repo GitHub Release with the CHANGELOG section.