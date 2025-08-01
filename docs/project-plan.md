# Project Plan: cgateweb Improvements

This document tracks the progress of improvements and refactoring for the cgateweb project.

## Previous Work

*   [x] **Refactor Queue Implementation:** (2024-07-27) Created `ThrottledQueue`, added tests.
*   [x] **Improve Error Handling & Connection Management:** (2024-07-27) Added exponential backoff, try/catch, error logging.
*   [x] **Add Relay/Switch/Cover/PIR Support to HA Discovery:** (2024-07-30) Added settings, updated discovery logic, refactored for nested apps.
*   [x] **Fix Broken Unit Tests:** (2024-07-30) Fixed HA discovery and error handling tests.
*   [x] **Enhance Readability (Constants):** (2024-07-30) Replaced magic strings/numbers.
*   [x] **Enhance Readability (Extract Handlers):** (2024-07-30) Extracted MQTT/C-Gate logic.
*   [x] **Enhance Readability & Structure:** (2024-07-30) Smaller functions, improved parser robustness.
*   [x] **Introduce Testing (Parsers):** (2024-07-30) Added tests for `CBusEvent`, `CBusCommand`, fixed bugs.
*   [x] **Introduce Testing (Core Logic):** (2024-07-30) Added tests for `CgateWebBridge` (connection, data handling), `install-service.js`.
*   [x] **SSL/TLS Support:** (2024-07-31) Added experimental SSL/TLS for C-Gate connections, added tests.
*   [x] **Code Comments:** (2024-07-30) Added comments for clarity.
*   [x] **Error Handling & Resilience:** (2024-07-30) Improved parsing of C-Gate errors, added checks around `socket.write()`.
*   [x] **Configuration & Startup:** (2024-07-30, 2024-07-31) Validated settings, read version dynamically from `package.json`.
*   [x] **MQTT Enhancements:** (2024-07-30) Implemented MQTT LWT.

## Current/Future Tasks

*   [x] **Dependency Review:** (2024-07-31)
    *   [x] Evaluate if `xml2js` dependency can be removed by parsing the text-based `TREE` command instead of `TREEXML`. (Decision: Kept `xml2js` as `TREEXML` is designed for application parsing and `TREE` output is complex/unreliable to parse programmatically).
*   [ ] **Feature Expansion:** Implement additional C-Gate commands/applications beyond lighting.
*   [ ] **Operational:**
    *   [ ] Add Dockerfile.

---
