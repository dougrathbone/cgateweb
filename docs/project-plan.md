# Project Plan: cgateweb Improvements

This document tracks the progress of improvements and refactoring for the cgateweb project.

## Initial Analysis & Suggested Tasks (2024-07-27)

Based on initial review of `index.js`, `project-guide.md`, and related files.

**Potential Tasks:**

*   [x] **Refactor Queue Implementation:** (2024-07-27)
    *   Created a reusable `ThrottledQueue` class in `index.js`.
    *   Replaced `queue` and `queue2` with instances of `ThrottledQueue`.
    *   Added unit tests for `ThrottledQueue` in `tests/throttledQueue.test.js`.
    *   Created `tests/test-standards.md`.
*   [x] **Improve Error Handling & Connection Management:** (2024-07-27)
    *   Implemented exponential backoff for C-Gate connection retries (`command` and `event` sockets).
    *   Added robust `try...catch` blocks around C-Gate data parsing logic in `command.on('data')` and `event.on('data')`.
    *   Improved logging for parsing errors.
    *   Added explicit error handler (`client.on('error', ...)`) for the MQTT client.
*   [x] **Add Relay Support to HA Discovery:** (2024-07-30)
    *   Added `ha_discovery_relay_app_id` setting.
    *   Updated `_publishHaDiscoveryFromTree` to find relays and publish them as HA `switch` entities.
    *   Refactored `_publishHaDiscoveryFromTree` to handle nested C-Bus applications (e.g., EnableControl within Lighting) and prioritize discovery based on App IDs (cover > switch > relay if IDs overlap).
*   [x] **Fix Broken Unit Tests:** (2024-07-30)
    *   Diagnosed failures in `tests/haDiscovery.test.js` caused by HA discovery refactoring.
    *   Adjusted tests to disable conflicting discovery types (e.g., disable cover discovery when testing switches with the same App ID).
    *   Corrected expected call counts in tests to match devices found by improved discovery logic.
    *   Fixed mock data structure in error handling test.
*   [x] **Enhance Readability (Constants):** (2024-07-30)
    *   Defined constants for MQTT topics, payloads, C-Gate commands, responses, levels, HA discovery parameters.
    *   Replaced magic strings/numbers with constants throughout `index.js`.
*   [x] **Enhance Readability (Extract Handlers):** (2024-07-30)
    *   Extracted MQTT command handling logic from `_handleMqttMessage` into separate helper methods.
    *   Extracted C-Gate command response parsing and processing logic from `_handleCommandData` into separate helper methods.
    *   Extracted C-Gate event processing logic from `_handleEventData` into `_processEventLine`.
*   [x] **Enhance Readability & Structure:** // Complete
    *   [x] Extract logic from large handlers (`client.on('message')`, `command.on('data')`, `event.on('data')`) into smaller functions. 
    *   [x] Improve robustness of `CBusEvent` and `CBusCommand` parsing (consider regex).
*   [x] **Introduce Testing (Parsers):** (2024-07-30)
    *   Created `tests/cbusEvent.test.js` and `tests/cbusCommand.test.js`.
    *   Added tests covering valid/invalid parsing, edge cases, and level calculations.
    *   Fixed edge case bugs found in parsing logic.
*   [x] **Introduce Testing:** // Complete
    *   [x] Set up a testing framework (e.g., Jest/Mocha). 
    *   [x] Create a `/tests` directory structure. 
    *   [x] Write initial unit tests for parsing logic (`CBusEvent`, `CBusCommand`). 
    *   [x] Write unit tests for the (refactored) queue logic. 
    *   [x] Add tests for CgateWebBridge connection logic (`start`, `stop`, `_handle*Connect`, `_checkAllConnected`). (2024-07-30)
    *   [x] Add tests for CgateWebBridge data handling logic (`_handleMqttMessage`, `_handleCommandData`, `_handleEventData` helpers). (2024-07-30)
    *   [x] Plan for mocking network dependencies (`net`, `mqtt`). // Done (via existing mocks + added reconnect tests) (2024-07-30)
*   [ ] **Dependency Review:**
    *   Evaluate if `xml2js` dependency can be removed by parsing the text-based `TREE` command instead of `TREEXML`. (Decision: Likely keep `xml2js` for easier XML parsing).
*   [x] **Configuration (Ports):** (2024-07-30)
    *   [x] Move hardcoded ports (20023, 20025) to `settings.js` or constants. // Verified already done via settings

**Future Goals (From project-guide.md):**

*   [ ] **Feature Expansion:** Implement additional C-Gate commands/applications beyond lighting.
*   [x] **Code Comments:** Add comments where clarity is needed, especially for complex C-Gate interactions. (2024-07-30)

---
