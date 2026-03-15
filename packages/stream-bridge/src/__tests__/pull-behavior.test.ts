/**
 * Pull Behavior Tests
 *
 * These tests verify that each approach is truly pull-based.
 * A pull-based stream should only produce values when the consumer
 * requests them (calls next() on the subscription).
 *
 * If a stream is push-based, it would produce all values immediately
 * regardless of consumer demand.
 */
import { describe, it, expect } from 'vitest'
import { run, call, type Operation } from 'effection'
import { createCountingGenerator } from '../test-utils.ts'
import { createReadableStreamBridge } from '../approaches/readable-stream-bridge.ts'
import { createAsyncIterableResponse } from '../approaches/async-iterable-response.ts'
import { createScopeCapturedStream } from '../approaches/scope-captured-stream.ts'

async function readNValues(body: ReadableStream<Uint8Array>, n: number): Promise<number[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const results: number[] = []

  for (let i = 0; i < n; i++) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value)
    // Handle NDJSON - each line is a separate JSON value
    const lines = text.trim().split('\n')
    for (const line of lines) {
      if (line) {
        results.push(JSON.parse(line))
        if (results.length >= n) break
      }
    }
  }

  reader.releaseLock()
  return results
}

describe('Pull Behavior', () => {
  describe('createReadableStreamBridge (Approach 1)', () => {
    it('should only pull values when consumer requests them', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 10 })
        const response = yield* createReadableStreamBridge(stream)

        const body = response.body
        expect(body).not.toBeNull()

        const results = yield* call(() => readNValues(body!, 3))

        // Verify we got the expected values
        expect(results).toEqual([0, 1, 2])

        // Verify pullLog only contains pulled values
        // This proves the stream is pull-based
        expect(pullLog).toEqual([0, 1, 2])
      })
    })

    it('should handle slow consumers with backpressure', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 5, delayMs: 10 })
        const response = yield* createReadableStreamBridge(stream)

        const body = response.body
        expect(body).not.toBeNull()

        const results = yield* call(() => readNValues(body!, 3))

        expect(results).toEqual([0, 1, 2])
        expect(pullLog).toEqual([0, 1, 2])
      })
    })
  })

  describe('createAsyncIterableResponse (Approach 2)', () => {
    it('should only pull values when consumer requests them', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 10 })
        const response = yield* createAsyncIterableResponse(stream)

        const body = response.body as unknown as AsyncIterable<Uint8Array>
        expect(body).toBeDefined()

        const decoder = new TextDecoder()
        const results: number[] = []

        // Pull only 3 values
        yield* call(async () => {
          for await (const chunk of body) {
            const text = decoder.decode(chunk)
            const lines = text.trim().split('\n')
            for (const line of lines) {
              if (line) {
                results.push(JSON.parse(line))
                if (results.length >= 3) break
              }
            }
            if (results.length >= 3) break
          }
        })

        expect(results).toEqual([0, 1, 2])
        expect(pullLog).toEqual([0, 1, 2])
      })
    })
  })

  describe('createScopeCapturedStream (Approach 3)', () => {
    it('should only pull values when consumer requests them', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 10 })
        const { response } = yield* createScopeCapturedStream(stream)

        const body = response.body
        expect(body).not.toBeNull()

        const results = yield* call(() => readNValues(body!, 3))

        expect(results).toEqual([0, 1, 2])
        expect(pullLog).toEqual([0, 1, 2])
      })
    })
  })
})
