
## Product Requirements Document (PRD) / Base Context: cgateweb

**1. Project Overview**

* **Project Name:** cgateweb
* **Repository:** [https://github.com/dougrathbone/cgateweb](https://github.com/dougrathbone/cgateweb)
* **Core Purpose:** To act as a bidirectional gateway or bridge between a Clipsal C-Bus home automation system (specifically interacting via the C-Gate interface) and an MQTT broker.
* **Technology:** Node.js

**2. Goals**

* Enable monitoring of C-Bus lighting states (On/Off, Dim Level) via MQTT topics.
* Enable control of C-Bus lighting (Switching On/Off, Ramping/Dimming) by publishing messages to specific MQTT topics.
* Provide a mechanism to query the status of all C-Bus devices and the network structure.
* Facilitate integration of C-Bus systems with MQTT-based smart home platforms (e.g., OpenHAB, Home Assistant).

**3. Core Functionality**

* **C-Gate Connection:** The application establishes a Telnet connection to a C-Gate server associated with the target C-Bus network. It listens for events broadcast by C-Gate.
* **MQTT Connection:** The application connects to a specified MQTT broker (details configured in `settings.js`).
* **Event Translation (C-Gate -> MQTT):**
    * Receives lighting status updates (e.g., group on/off, level changes) from C-Gate via Telnet.
    * Parses these events.
    * Publishes the corresponding state (`ON`/`OFF`) or level (presumed `0`-`100`) to specific MQTT topics under the `cbus/read/...` hierarchy.
* **Command Translation (MQTT -> C-Gate):**
    * Subscribes to specific MQTT topics under the `cbus/write/...` hierarchy.
    * Receives commands (e.g., `ON`, `OFF`, percentage level, `INCREASE`/`DECREASE`, `getall`, `gettree`) published to these topics.
    * Parses these commands.
    * Translates them into the appropriate C-Gate Telnet commands and sends them to the C-Gate server.
* **Configuration:** Key parameters like C-Gate server IP/port, MQTT broker IP/port, credentials (if any), and optional behaviors (like update on start/periodic updates) are managed in the `settings.js` file.

**4. Key Features Detailed by MQTT Topics**

* **Monitoring (C-Gate -> MQTT):**
    * `cbus/read/<network>/<application>/<group>/state`: Publishes `ON` or `OFF` when the group's state changes.
    * `cbus/read/<network>/<application>/<group>/level`: Publishes the current dim level (presumably 0-100) when the group's level changes.
    * `cbus/read/<network>///tree`: Publishes a JSON representation of the C-Bus network structure upon request.
* **Control (MQTT -> C-Gate):**
    * `cbus/write/<network>/<application>/<group>/switch`: Accepts `ON` or `OFF` payload to turn the group on/off.
    * `cbus/write/<network>/<application>/<group>/ramp`:
        * Accepts a percentage (e.g., `50`) to ramp to that level.
        * Accepts percentage and time (e.g., `50,4s`, `100,2m`) for timed ramps.
        * Accepts `INCREASE` or `DECREASE` to ramp level up/down by a predefined step (5% noted).
        * Accepts `ON` or `OFF` as synonyms for 100% / 0% ramp (or immediate switch?).
    * `cbus/write/<network>/<application>//getall`: Triggers a query to C-Gate to get the current status of all groups; results are published on the respective `cbus/read/...` topics.
    * `cbus/write/<network>///gettree`: Triggers a query to C-Gate for the network tree; the result is published on `cbus/read/<network>///tree`.

*(Where `<network>`, `<application>`, and `<group>` are placeholders for the specific C-Bus addressing identifiers).*

**5. Architecture & Dependencies**

* **Language:** Node.js
* **Key Protocols:** Telnet (for C-Gate), MQTT
* **Runtime:** Node.js environment
* **Configuration:** `settings.js` file
* **External System Dependencies:**
    * A running C-Gate server connected to a C-Bus network.
    * An accessible MQTT Broker.
* **Core Node Modules (Inferred):** An MQTT client library (e.g., `mqtt`), a Telnet client library or built-in `net` module.

**6. Assumptions & Constraints**

* Assumes default C-Gate Telnet ports are used (typically 20023 for events, 20025 for interface?).
* Primarily designed for C-Bus *lighting* applications. HVAC control is explicitly mentioned as *not* implemented in this version (referenced fork exists).
* Relies on the C-Gate server being stable and accessible on the network.
* Relies on the MQTT broker being stable and accessible.
* The format and specific commands for C-Gate Telnet interaction are embedded within the application logic.

**7. Deployment**

* Designed to run as a persistent background service.
* Includes a `systemd` service file (`cgateweb.service`) for easy setup on Linux systems (like Raspberry Pi).

**8. Home Assistant MQTT Discovery**

*   `cgateweb` supports automatic discovery of C-Bus lighting groups within Home Assistant using the MQTT Discovery protocol.
*   When enabled via `settings.js` (`ha_discovery_enabled: true`), `cgateweb` will query the C-Gate network structure using `TREEXML` and publish configuration messages to the specified MQTT discovery prefix (default: `homeassistant`).
*   This allows Home Assistant to automatically find and add C-Bus lights as `light` entities, and C-Bus relays/blinds (using the Enable Control application, default App ID 203) as basic `cover` entities (open/close).
*   Configuration options in `settings.js` include enabling the feature, setting the discovery topic prefix, specifying which C-Bus networks to scan, and configuring the Application ID for covers.
*   See `docs/project-homeassistant-discovery.md` for detailed requirements and implementation notes.

---

**9. Context Questions & Development Goals for Gemini Assistance**

* **Error Handling:** How does the script currently handle potential errors (C-Gate/MQTT disconnects, invalid commands, C-Gate errors, network issues)? Does it attempt reconnections? How robust is this? *(Answering this helps establish the baseline before improvement)*.
* **State Management:** Does `cgateweb` maintain internal state, or rely purely on C-Gate events/`getall`? How are potential inconsistencies handled? *(Understanding this is crucial for stability improvements)*.
* **C-Gate Protocol Specifics:** Are specific C-Gate Telnet command formats/parsing logic important to know? *(Needed for expanding functionality)*.
* **Dependencies:** What are the primary Node.js libraries currently used (from `package.json`)? *(Relevant for dependency minimization goal)*.
* **Configuration Details:** What exact parameters are configurable in `settings.js`? *(General context)*.
* **Security:** Current security considerations implemented or needed? *(General context/potential improvement area)*.
* **Scalability:** Any known limitations with large C-Bus networks or high message volumes? *(Relevant for stability improvements)*.
* **Logging:** Current logging level, configurability, and output? *(Important for debugging and stability)*.
* **Primary Goals for Gemini Assistance:** Please focus on helping with the following types of tasks:
    * **Refactoring:** Improve overall code stability, enhance readability, and add comments where clarity is needed.
    * **Dependency Management:** Analyze current external dependencies and suggest/implement ways to minimize them, favoring built-in Node.js modules where practical.
    * **Feature Expansion:** Implement additional C-Gate commands and features based on C-Gate documentation, extending capabilities beyond the current lighting focus.
    * **Testing:** Introduce unit tests for core functionality, structuring the test code within a `/tests` subfolder.

---

This revised document should give Gemini a solid foundation for understanding `cgateweb` and the specific areas you want assistance with. Remember to provide answers to the context questions (points 1-9 in the last section) when you interact with Gemini for specific tasks, as that will further refine its understanding of the current state.

---

**10. Testing Standards**

This section outlines the basic standards and conventions for writing tests for the `cgateweb` project.

### 10.1 Testing Framework

*   **Jest:** We will use [Jest](https://jestjs.io/) as the primary testing framework due to its integrated nature (assertions, mocking, coverage) and popularity in the Node.js ecosystem.

### 10.2 File Naming and Location

*   Test files should be located within the `/tests` directory.
*   Test files should mirror the directory structure of the source code where applicable (e.g., tests for `src/utils/helper.js` might go in `tests/utils/helper.test.js`). For now, top-level files like `index.js` can have tests directly in `/tests` (e.g., `tests/index.test.js` or `tests/throttledQueue.test.js`).
*   Test files must use the `.test.js` suffix (e.g., `throttledQueue.test.js`).

### 10.3 Test Structure

*   Tests should follow the **Arrange-Act-Assert (AAA)** pattern:
    *   **Arrange:** Set up preconditions, initialize objects, create mocks.
    *   **Act:** Execute the code under test.
    *   **Assert:** Verify the outcome using Jest's `expect` assertions.
*   Use `describe` blocks to group related tests for a specific function, module, or class.
*   Use `it` or `test` blocks for individual test cases. Test descriptions should clearly state what is being tested.
*   Use `beforeEach`, `afterEach`, `beforeAll`, `afterAll` for setup and teardown logic as needed.

### 10.4 Mocking and Spies

*   Use Jest's built-in mocking capabilities (`jest.fn()`, `jest.mock()`, `jest.spyOn()`) to isolate the code under test from its dependencies (like network modules, timers, external libraries).
*   Avoid mocking modules that are part of the core logic being tested unless absolutely necessary.

### 10.5 Test Types

*   **Unit Tests:** Focus primarily on unit tests that verify small, isolated pieces of functionality (e.g., a single function or class method). These should form the bulk of the test suite.
*   **Integration Tests:** May be added later to test the interaction between different components (e.g., MQTT message parsing and C-Gate command generation), but prioritize unit tests first.

### 10.6 Assertions

*   Use specific Jest matchers (`.toBe()`, `.toEqual()`, `.toHaveBeenCalledWith()`, `.toThrow()`, etc.) rather than generic ones where possible.
*   Write assertions that are clear and directly relate to the expected outcome of the test.

### 10.7 Coverage

*   Aim for reasonable code coverage, but focus on testing critical paths and logic rather than striving for 100% coverage arbitrarily. Use coverage reports (`npm test -- --coverage`) as a guide.
*   **Running Tests:** Execute the test suite using the command `npx jest` from the project root directory.