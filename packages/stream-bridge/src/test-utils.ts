/**
 * Test Utilities
 *
 * Provides a simple counting generator for testing pull-based behavior.
 * The generator yields numbers and tracks when values are actually pulled,
 * allowing us to verify that streams are truly pull-based (not push-based).
 */
import { resource, sleep, type Operation, type Stream } from 'effection'

export interface CountingGeneratorOptions {
  /** Maximum number of items to yield (prevents infinite loop in tests) */
  maxCount?: number
  /** Delay in ms between yields (simulates work) */
  delayMs?: number
}

export interface CountingGeneratorResult {
  /** The stream that yields numbers */
  stream: Stream<number, void>
  /** Array that records when each value was yielded (pulled by consumer) */
  pullLog: number[]
}

/**
 * Creates a counting generator for testing pull-based behavior.
 *
 * The pullLog array records each value as it's yielded, allowing tests
 * to verify that values are only produced when the consumer pulls them.
 *
 * IMPORTANT: This is truly pull-based. Values are only generated when
 * the consumer calls next() on the subscription.
 *
 * @example
 * ```typescript
 * const { stream, pullLog } = createCountingGenerator({ maxCount: 10 })
 *
 * // Pull only 3 values
 * const sub = yield* stream
 * for (let i = 0; i < 3; i++) {
 *   const result = yield* sub.next()
 *   console.log(result.value) // 0, 1, 2
 * }
 *
 * // pullLog should be [0, 1, 2] - not [0..9]
 * // This proves the stream is pull-based
 * ```
 */
export function createCountingGenerator(
  options: CountingGeneratorOptions = {}
): CountingGeneratorResult {
  const { maxCount = 100, delayMs = 0 } = options
  const pullLog: number[] = []

  const stream: Stream<number, void> = resource(function* (provide) {
    let count = 0

    yield* provide({
      *next(): Operation<IteratorResult<number, void>> {
        if (count >= maxCount) {
          return { done: true, value: undefined }
        }

        if (delayMs > 0) {
          yield* sleep(delayMs)
        }

        const value = count
        pullLog.push(value)
        count++

        return { done: false, value }
      },
    })
  })

  return { stream, pullLog }
}

/**
 * Creates a counting generator that tracks pull timing.
 * Useful for verifying backpressure behavior.
 */
export interface TimedPullLogEntry {
  value: number
  pulledAt: number
}

export interface TimedCountingGeneratorResult {
  stream: Stream<number, void>
  pullLog: TimedPullLogEntry[]
}

export function createTimedCountingGenerator(
  options: CountingGeneratorOptions = {}
): TimedCountingGeneratorResult {
  const { maxCount = 100, delayMs = 0 } = options
  const pullLog: TimedPullLogEntry[] = []

  const stream: Stream<number, void> = resource(function* (provide) {
    let count = 0

    yield* provide({
      *next(): Operation<IteratorResult<number, void>> {
        if (count >= maxCount) {
          return { done: true, value: undefined }
        }

        if (delayMs > 0) {
          yield* sleep(delayMs)
        }

        const value = count
        pullLog.push({ value, pulledAt: Date.now() })
        count++

        return { done: false, value }
      },
    })
  })

  return { stream, pullLog }
}
