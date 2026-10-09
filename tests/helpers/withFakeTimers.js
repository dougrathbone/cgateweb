/**
 * Install fake timers for the duration of fn, always restoring real timers
 * afterward — including when an expectation throws. Leaving fake timers
 * installed after a failed test is what hangs later suites that poll real
 * wall-clock deadlines (nightly Node 20 flake after v1.34.1).
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withFakeTimers(fn) {
    jest.useFakeTimers();
    try {
        return fn();
    } finally {
        jest.useRealTimers();
    }
}

/**
 * Async variant of withFakeTimers.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFakeTimersAsync(fn) {
    jest.useFakeTimers();
    try {
        return await fn();
    } finally {
        jest.useRealTimers();
    }
}

module.exports = { withFakeTimers, withFakeTimersAsync };
