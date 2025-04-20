# Test Standards for cgateweb

This document outlines the basic standards and conventions for writing tests for the `cgateweb` project.

## 1. Testing Framework

*   **Jest:** We will use [Jest](https://jestjs.io/) as the primary testing framework due to its integrated nature (assertions, mocking, coverage) and popularity in the Node.js ecosystem.

## 2. File Naming and Location

*   Test files should be located within the `/tests` directory.
*   Test files should mirror the directory structure of the source code where applicable (e.g., tests for `src/utils/helper.js` might go in `tests/utils/helper.test.js`). For now, top-level files like `index.js` can have tests directly in `/tests` (e.g., `tests/index.test.js` or `tests/throttledQueue.test.js`).
*   Test files must use the `.test.js` suffix (e.g., `throttledQueue.test.js`).

## 3. Test Structure

*   Tests should follow the **Arrange-Act-Assert (AAA)** pattern:
    *   **Arrange:** Set up preconditions, initialize objects, create mocks.
    *   **Act:** Execute the code under test.
    *   **Assert:** Verify the outcome using Jest's `expect` assertions.
*   Use `describe` blocks to group related tests for a specific function, module, or class.
*   Use `it` or `test` blocks for individual test cases. Test descriptions should clearly state what is being tested.
*   Use `beforeEach`, `afterEach`, `beforeAll`, `afterAll` for setup and teardown logic as needed.

## 4. Mocking and Spies

*   Use Jest's built-in mocking capabilities (`jest.fn()`, `jest.mock()`, `jest.spyOn()`) to isolate the code under test from its dependencies (like network modules, timers, external libraries).
*   Avoid mocking modules that are part of the core logic being tested unless absolutely necessary.

## 5. Test Types

*   **Unit Tests:** Focus primarily on unit tests that verify small, isolated pieces of functionality (e.g., a single function or class method). These should form the bulk of the test suite.
*   **Integration Tests:** May be added later to test the interaction between different components (e.g., MQTT message parsing and C-Gate command generation), but prioritize unit tests first.

## 6. Assertions

*   Use specific Jest matchers (`.toBe()`, `.toEqual()`, `.toHaveBeenCalledWith()`, `.toThrow()`, etc.) rather than generic ones where possible.
*   Write assertions that are clear and directly relate to the expected outcome of the test.

## 7. Coverage

*   Aim for reasonable code coverage, but focus on testing critical paths and logic rather than striving for 100% coverage arbitrarily. Use coverage reports (`npm test -- --coverage`) as a guide. 