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
*   [ ] **Enhance Readability & Structure:**
    *   Define constants for magic strings/numbers (ports, C-Gate codes, MQTT paths, ramp steps).
    *   Extract logic from large handlers (`client.on('message')`, `command.on('data')`, `event.on('data')`) into smaller functions.
    *   Improve robustness of `CBusEvent` and `CBusCommand` parsing (consider regex).
*   [ ] **Introduce Testing:**
    *   Set up a testing framework (e.g., Jest/Mocha).
    *   Create a `/tests` directory structure.
    *   Write initial unit tests for parsing logic (`CBusEvent`, `CBusCommand`).
    *   Write unit tests for the (refactored) queue logic.
    *   Plan for mocking network dependencies (`net`, `mqtt`).
*   [ ] **Dependency Review:**
    *   Evaluate if `xml2js` dependency can be removed by parsing the text-based `TREE` command instead of `TREEXML`. (Decision: Likely keep `xml2js` for easier XML parsing).
*   [ ] **Configuration:**
    *   Move hardcoded ports (20023, 20025) to `settings.js` or constants.

**Future Goals (From project-guide.md):**

*   [ ] **Feature Expansion:** Implement additional C-Gate commands/applications beyond lighting.
*   [ ] **Code Comments:** Add comments where clarity is needed, especially for complex C-Gate interactions.

---
