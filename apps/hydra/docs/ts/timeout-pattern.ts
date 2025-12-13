// timeout-pattern.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function* timeout<T>(ms: number): Operation<T> {
  yield* sleep(ms);
  throw new TimeoutError(ms);
}

function* withTimeout<T>(operation: Operation<T>, ms: number): Operation<T> {
  return yield* race([
    operation,
    timeout<T>(ms),
  ]);
}

// Simulated slow API
function* slowFetch(): Operation<string> {
  yield* sleep(5000);
  return 'data';
}

await main(function*() {
  try {
    const result: string = yield* withTimeout(slowFetch(), 1000);
    console.log('Result:', result);
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.log('Request timed out!');
    } else {
      throw error;
    }
  }
});
