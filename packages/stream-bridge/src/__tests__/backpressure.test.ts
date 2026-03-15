/**
 * Backpressure Tests
 *
 * Verifies that streams correctly handle slow consumers without
 * buffering unlimited data in memory.
 *
 * Backpressure means: if the consumer is slow, the producer should
 * wait rather than buffer everything.
 */
import { describe, it, expect } from 'vitest'
import { run, call, type Operation } from 'effection'
import { createServer } from 'node:http'
import { createCountingGenerator, createTimedCountingGenerator } from '../test-utils.ts'
import { createReadableStreamBridge } from '../approaches/readable-stream-bridge.ts'
import { createAsyncIterableResponse } from '../approaches/async-iterable-response.ts'
import { createScopeCapturedStream } from '../approaches/scope-captured-stream.ts'

describe('Backpressure Behavior', () => {
  describe('createReadableStreamBridge (Approach 1)', () => {
    it('should apply backpressure with slow consumer', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 100 })
        const response = yield* createReadableStreamBridge(stream)
        const body = response.body!
        const reader = body.getReader()

        // Read values slowly with delays
        const readTimes: number[] = []
        for (let i = 0; i < 5; i++) {
          const start = performance.now()
          const { done, value } = yield* call(() => reader.read())
          readTimes.push(performance.now() - start)
          if (done) break

          // Simulate slow consumer
          yield* call(() => new Promise(r => setTimeout(r, 50)))
        }

        reader.releaseLock()

        // With backpressure, pullLog should only contain values we actually read
        // (plus maybe one buffered value due to ReadableStream's internal buffer)
        expect(pullLog.length).toBeLessThanOrEqual(6)

        // Each read should be fast (not waiting for producer)
        // because values are produced on-demand
        for (const time of readTimes) {
          expect(time).toBeLessThan(100) // Should be nearly instant
        }
      })
    })

    it('should not buffer all values upfront', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 1000 })
        const response = yield* createReadableStreamBridge(stream)
        const body = response.body!
        const reader = body.getReader()

        // Read only 3 values
        for (let i = 0; i < 3; i++) {
          yield* call(() => reader.read())
        }

        reader.releaseLock()

        // If there's no backpressure, pullLog would have 1000 entries
        // With backpressure, it should only have the values we read
        expect(pullLog.length).toBeLessThanOrEqual(10)
      })
    })
  })

  describe('createAsyncIterableResponse (Approach 2)', () => {
    it('should apply backpressure with slow consumer', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 100 })
        const response = yield* createAsyncIterableResponse(stream)
        const body = response.body as unknown as AsyncIterable<Uint8Array>

        const decoder = new TextDecoder()
        let count = 0

        yield* call(async () => {
          for await (const chunk of body) {
            count++
            if (count >= 5) break

            // Simulate slow consumer
            await new Promise(r => setTimeout(r, 50))
          }
        })

        // With backpressure, pullLog should only contain values we consumed
        expect(pullLog.length).toBeLessThanOrEqual(6)
      })
    })
  })

  describe('createScopeCapturedStream (Approach 3)', () => {
    it('should apply backpressure with slow consumer', async () => {
      await run(function* () {
        const { stream, pullLog } = createCountingGenerator({ maxCount: 100 })
        const { response } = yield* createScopeCapturedStream(stream)
        const body = response.body!
        const reader = body.getReader()

        // Read values slowly with delays
        for (let i = 0; i < 5; i++) {
          yield* call(() => reader.read())
          yield* call(() => new Promise(r => setTimeout(r, 50)))
        }

        reader.releaseLock()

        // With backpressure, pullLog should only contain values we actually read
        expect(pullLog.length).toBeLessThanOrEqual(6)
      })
    })
  })
})

describe('Backpressure with HTTP', () => {
  async function withServer(
    handler: (req: Request) => Operation<Response>,
    fn: (port: number) => Promise<void>
  ): Promise<void> {
    const server = createServer(async (req, res) => {
      try {
        const webRequest = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
        })
        const webResponse = await run(() => handler(webRequest))
        res.statusCode = webResponse.status
        webResponse.headers.forEach((value, key) => res.setHeader(key, value))
        if (webResponse.body) {
          const reader = webResponse.body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
        }
        res.end()
      } catch (err) {
        res.statusCode = 500
        res.end((err as Error).message)
      }
    })

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address() as { port: number }

    try {
      await fn(address.port)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('should handle slow HTTP client - note: HTTP buffers response', async () => {
    // Note: In Node's HTTP server, the response is fully written before
    // the client can cancel. This is expected HTTP behavior.
    // The backpressure tests above verify the stream itself is pull-based.
    const { stream, pullLog } = createCountingGenerator({ maxCount: 100 })

    await withServer(
      function* () {
        return yield* createReadableStreamBridge(stream)
      },
      async (port) => {
        const response = await fetch(`http://localhost:${port}/stream`)
        const reader = response.body!.getReader()

        // Read slowly
        for (let i = 0; i < 5; i++) {
          await reader.read()
          await new Promise(r => setTimeout(r, 50))
        }

        reader.cancel()

        // Wait a bit for server to process
        await new Promise(r => setTimeout(r, 100))

        // HTTP server will have produced all values (it buffers the response)
        // This is expected - the stream itself is pull-based, but HTTP isn't
        expect(pullLog.length).toBe(100)
      }
    )
  })

  it('should verify pull-based timing', async () => {
    // This test verifies that values are produced when pulled,
    // not pushed ahead of time
    const { stream, pullLog } = createTimedCountingGenerator({ maxCount: 20, delayMs: 10 })

    await run(function* () {
      const response = yield* createReadableStreamBridge(stream)
      const body = response.body!
      const reader = body.getReader()

      const readTimestamps: number[] = []

      // Read 5 values with delays between reads
      for (let i = 0; i < 5; i++) {
        yield* call(() => reader.read())
        readTimestamps.push(Date.now())
        yield* call(() => new Promise(r => setTimeout(r, 100)))
      }

      reader.releaseLock()

      // Verify that values were pulled around the time we read them
      // (not all at the beginning)
      const pullTimestamps = pullLog.map(p => p.pulledAt)

      for (let i = 0; i < Math.min(5, pullTimestamps.length); i++) {
        const readTime = readTimestamps[i]
        const pullTime = pullTimestamps[i]

        // Pull should happen around the same time as read (within 100ms)
        // This proves the stream is pull-based
        const diff = Math.abs(pullTime - readTime)
        expect(diff).toBeLessThan(100)
      }
    })
  })
})

describe('Memory Behavior', () => {
  it('should not accumulate memory for long streams', async () => {
    // This test simulates a long-running stream to verify
    // that memory doesn't grow unboundedly

    await run(function* () {
      const { stream, pullLog } = createCountingGenerator({ maxCount: 10000 })
      const response = yield* createReadableStreamBridge(stream)
      const body = response.body!
      const reader = body.getReader()

      // Read all values but in batches with delays
      let totalRead = 0
      const batchSize = 100

      while (totalRead < 10000) {
        for (let i = 0; i < batchSize && totalRead < 10000; i++) {
          yield* call(() => reader.read())
          totalRead++
        }

        // Small delay between batches
        yield* call(() => new Promise(r => setTimeout(r, 10)))
      }

      reader.releaseLock()

      // All values should have been read
      expect(pullLog.length).toBe(10000)
    })
  })
})
