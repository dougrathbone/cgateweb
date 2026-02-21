// NOTE: This requires Jest to be installed (npm install --save-dev jest)
// Run tests using 'npx jest' or configure package.json script

const ThrottledQueue = require('../src/throttledQueue');

// --- Tests --- 

// Use Jest's fake timers
jest.useFakeTimers();

describe('ThrottledQueue', () => {
    let mockProcessFn;
    let queue;
    const intervalMs = 100;

    beforeEach(() => {
        // Reset mocks and queue before each test
        mockProcessFn = jest.fn();
        queue = new ThrottledQueue(mockProcessFn, intervalMs);
        // Clear any pending timers
        jest.clearAllTimers();
    });

    it('should process the first item immediately when added', () => {
        queue.add('item1');
        expect(mockProcessFn).toHaveBeenCalledTimes(1);
        expect(mockProcessFn).toHaveBeenCalledWith('item1');
        expect(queue.length).toBe(0);
    });

    it('should process subsequent items after the interval', () => {
        queue.add('item1'); // Processed immediately
        expect(mockProcessFn).toHaveBeenCalledTimes(1);
        expect(mockProcessFn).toHaveBeenCalledWith('item1');

        queue.add('item2');
        queue.add('item3');
        expect(mockProcessFn).toHaveBeenCalledTimes(1); // No more immediate processing
        expect(queue.length).toBe(2);

        // Advance time by slightly less than the interval
        jest.advanceTimersByTime(intervalMs - 1);
        expect(mockProcessFn).toHaveBeenCalledTimes(1);

        // Advance time to trigger the interval
        jest.advanceTimersByTime(1);
        expect(mockProcessFn).toHaveBeenCalledTimes(2);
        expect(mockProcessFn).toHaveBeenCalledWith('item2');
        expect(queue.length).toBe(1);

        // Advance time again for the next item
        jest.advanceTimersByTime(intervalMs);
        expect(mockProcessFn).toHaveBeenCalledTimes(3);
        expect(mockProcessFn).toHaveBeenCalledWith('item3');
        expect(queue.length).toBe(0);
    });

     it('should stop the interval when the queue becomes empty', () => {
        queue.add('item1'); // Processed immediately
        queue.add('item2');
        expect(queue.length).toBe(1);

        // Advance time to process item2
        jest.advanceTimersByTime(intervalMs);
        expect(mockProcessFn).toHaveBeenCalledTimes(2);
        expect(queue.length).toBe(0);
        expect(queue.isEmpty).toBe(true);

        // Check that the interval is cleared (Jest's fake timers track this)
        // We can verify by advancing time further and ensuring no more calls
        const initialCallCount = mockProcessFn.mock.calls.length;
        jest.advanceTimersByTime(intervalMs * 5); // Advance well past the interval
        expect(mockProcessFn).toHaveBeenCalledTimes(initialCallCount);
    });

    it('should restart the interval and process immediately when adding to an empty, stopped queue', () => {
        // Add and process items until empty and interval is stopped
        queue.add('item1');
        expect(mockProcessFn).toHaveBeenCalledTimes(1); // Immediate call
        expect(queue.isEmpty).toBe(true);

        // Advance time enough for interval to run and stop itself because queue is empty
        jest.advanceTimersByTime(intervalMs * 2);
        expect(mockProcessFn).toHaveBeenCalledTimes(1); // No more calls

        // Add a new item to the now stopped queue
        queue.add('item2');
        // Should be processed immediately, restarting the interval cycle
        expect(mockProcessFn).toHaveBeenCalledTimes(2);
        expect(mockProcessFn).toHaveBeenCalledWith('item2');
        expect(queue.isEmpty).toBe(true);

        // Add another item - interval is running but queue is empty
        queue.add('item3');
        // This item is NOT processed immediately because the interval timer is now active.
        expect(mockProcessFn).toHaveBeenCalledTimes(2);
        expect(queue.length).toBe(1);

        // Advance timer to process the queued item
        jest.advanceTimersByTime(intervalMs);
        expect(mockProcessFn).toHaveBeenCalledTimes(3);
        expect(mockProcessFn).toHaveBeenCalledWith('item3');
        expect(queue.isEmpty).toBe(true);

         // Add two items quickly
        queue.add('item4'); // Item added to empty queue, interval already running -> NOT immediate
        expect(mockProcessFn).toHaveBeenCalledTimes(3);
        expect(queue.length).toBe(1);

        queue.add('item5'); // Queued
        expect(mockProcessFn).toHaveBeenCalledTimes(3);
        expect(queue.length).toBe(2);


        // Advance timer to process the next item ('item4')
        jest.advanceTimersByTime(intervalMs);
        expect(mockProcessFn).toHaveBeenCalledTimes(4);
        expect(mockProcessFn).toHaveBeenCalledWith('item4');
        expect(queue.length).toBe(1);

        // Advance timer to process the final item ('item5')
        jest.advanceTimersByTime(intervalMs);
        expect(mockProcessFn).toHaveBeenCalledTimes(5);
        expect(mockProcessFn).toHaveBeenCalledWith('item5');
        expect(queue.isEmpty).toBe(true);

         // Ensure interval stops again
        const finalCallCount = mockProcessFn.mock.calls.length;
        jest.advanceTimersByTime(intervalMs * 5);
        expect(mockProcessFn).toHaveBeenCalledTimes(finalCallCount);
    });

    it('should handle errors in the process function gracefully', () => {
        const error = new Error('Processing failed!');
        const failingProcessFn = jest.fn().mockImplementation((item) => {
            if (item === 'fail') {
                throw error;
            }
        });
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console output during test

        queue = new ThrottledQueue(failingProcessFn, intervalMs);

        queue.add('ok1'); // Processed immediately
        queue.add('fail'); // Queued
        queue.add('ok2'); // Queued

        expect(failingProcessFn).toHaveBeenCalledTimes(1);
        expect(failingProcessFn).toHaveBeenCalledWith('ok1');
        expect(queue.length).toBe(2);

        // Advance time to process 'fail'
        jest.advanceTimersByTime(intervalMs);
        expect(failingProcessFn).toHaveBeenCalledTimes(2);
        expect(failingProcessFn).toHaveBeenCalledWith('fail');
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error processing Queue item'));
        expect(queue.length).toBe(1); // 'fail' is consumed despite error

        // Advance time to process 'ok2'
        jest.advanceTimersByTime(intervalMs);
        expect(failingProcessFn).toHaveBeenCalledTimes(3);
        expect(failingProcessFn).toHaveBeenCalledWith('ok2');
        expect(queue.length).toBe(0);

        consoleErrorSpy.mockRestore(); // Clean up spy
    });

    it('should allow clearing the queue', () => {
        queue.add('item1'); // Processed immediately
        queue.add('item2');
        queue.add('item3');
        expect(queue.length).toBe(2);

        queue.clear();
        expect(queue.length).toBe(0);
        expect(queue.isEmpty).toBe(true);

        // Ensure no more processing happens
        jest.advanceTimersByTime(intervalMs * 5);
        expect(mockProcessFn).toHaveBeenCalledTimes(1); // Only the first immediate call
    });

     it('should throw error if processFn is not a function', () => {
        expect(() => new ThrottledQueue(null, 100)).toThrow('processFn for Queue must be a function');
        expect(() => new ThrottledQueue('not a function', 100)).toThrow('processFn for Queue must be a function');
    });

    it('should throw error if intervalMs is not a positive number', () => {
        expect(() => new ThrottledQueue(jest.fn(), 0)).toThrow('intervalMs for Queue must be a positive number');
        expect(() => new ThrottledQueue(jest.fn(), -100)).toThrow('intervalMs for Queue must be a positive number');
        expect(() => new ThrottledQueue(jest.fn(), 'not a number')).toThrow('intervalMs for Queue must be a positive number');
    });

    describe('Queue size limits', () => {
        it('should default to maxSize of 1000', () => {
            const queue = new ThrottledQueue(jest.fn(), 100);
            expect(queue.maxSize).toBe(1000);
        });

        it('should accept custom maxSize', () => {
            const queue = new ThrottledQueue(jest.fn(), 100, 'Test', { maxSize: 5 });
            expect(queue.maxSize).toBe(5);
        });

        it('should drop oldest items when queue is full', () => {
            jest.useFakeTimers();
            const processed = [];
            const queue = new ThrottledQueue(
                (item) => processed.push(item),
                100,
                'Test',
                { maxSize: 3 }
            );

            // First item processed immediately, remaining 4 queued
            queue.add('a');
            queue.add('b');
            queue.add('c');
            queue.add('d'); // Should drop 'b' (oldest in queue after 'a' was processed)
            
            // 'a' is processed immediately, queue has [b, c, d] but max is 3
            // Actually: after add('a'), queue has ['a'], process runs immediately and removes 'a'
            // After add('b'), queue has ['b']
            // After add('c'), queue has ['b', 'c']
            // After add('d'), queue has ['b', 'c', 'd'] - exactly at max, no drop
            
            // Let's fill past the limit
            queue.add('e'); // Now queue has ['c', 'd', 'e'] - 'b' dropped
            
            expect(queue.droppedCount).toBe(1);
            expect(queue.length).toBe(3);
            
            jest.useRealTimers();
        });

        it('should allow unlimited queue when maxSize is 0', () => {
            jest.useFakeTimers();
            const queue = new ThrottledQueue(jest.fn(), 100, 'Test', { maxSize: 0 });
            
            for (let i = 0; i < 5000; i++) {
                queue.add(i);
            }
            
            expect(queue.droppedCount).toBe(0);
            // 1 processed immediately, 4999 in queue
            expect(queue.length).toBe(4999);
            
            queue.clear();
            jest.useRealTimers();
        });

        it('should track total dropped count', () => {
            jest.useFakeTimers();
            const queue = new ThrottledQueue(jest.fn(), 100, 'Test', { maxSize: 2 });
            
            // Fill queue: first item processed immediately
            queue.add('a'); // Processed immediately, queue empty
            queue.add('b'); // queue: [b]
            queue.add('c'); // queue: [b, c]
            queue.add('d'); // drop b, queue: [c, d]
            queue.add('e'); // drop c, queue: [d, e]
            queue.add('f'); // drop d, queue: [e, f]
            
            expect(queue.droppedCount).toBe(3);
            
            queue.clear();
            jest.useRealTimers();
        });
    });
}); 