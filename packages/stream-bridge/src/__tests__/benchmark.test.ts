/**
 * Benchmark Tests
 *
 * Measures performance differences between approaches.
 * Each test runs multiple iterations to get stable measurements.
 */
import { describe, it, expect } from 'vitest'
import { run, call, type Operation } from 'effection'
import { createServer } from 'node:http'
import { createCountingGenerator } from '../test-utils.ts'
import { createReadableStreamBridge } from '../approaches/readable-stream-bridge.ts'
import { createAsyncIterableResponse } from '../approaches/async-iterable-response.ts'
import { createScopeCapturedStream } from '../approaches/scope-captured-stream.ts'

interface BenchmarkResult {
  approach: string
  totalTime: number
  itemCount: number
  itemsPerSecond: number
  avgTimePerItem: number
}

async function benchmarkApproach(
  name: string,
  createResponse: () => Operation<Response>,
  itemCount: number,
  iterations: number
): Promise<BenchmarkResult> {
  const times: number[] = []

  for (let i = 0; i < iterations; i++) {
    const start = performance.now()

    await run(function* () {
      const response = yield* createResponse()
      const body = response.body!
      const reader = body.getReader()

      let count = 0
      while (count < itemCount) {
        const { done, value } = yield* call(() => reader.read())
        if (done) break
        count++
      }
      reader.releaseLock()
    })

    const end = performance.now()
    times.push(end - start)
  }

  const totalTime = times.reduce((a, b) => a + b, 0)
  const avgTime = totalTime / iterations

  return {
    approach: name,
    totalTime: Math.round(totalTime * 100) / 100,
    itemCount,
    itemsPerSecond: Math.round((itemCount * iterations / totalTime) * 1000),
    avgTimePerItem: Math.round((avgTime / itemCount) * 1000) / 1000,
  }
}

describe('Benchmarks', () => {
  const ITEM_COUNT = 100
  const ITERATIONS = 10

  it('should benchmark all approaches', async () => {
    const results: BenchmarkResult[] = []

    // Approach 1: ReadableStream Bridge
    const result1 = await benchmarkApproach(
      'ReadableStream Bridge',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        return yield* createReadableStreamBridge(stream)
      },
      ITEM_COUNT,
      ITERATIONS
    )
    results.push(result1)

    // Approach 2: AsyncIterable Response
    const result2 = await benchmarkApproach(
      'AsyncIterable Response',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        return yield* createAsyncIterableResponse(stream)
      },
      ITEM_COUNT,
      ITERATIONS
    )
    results.push(result2)

    // Approach 3: Scope-Captured Stream
    const result3 = await benchmarkApproach(
      'Scope-Captured Stream',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        const result = yield* createScopeCapturedStream(stream)
        return result.response
      },
      ITEM_COUNT,
      ITERATIONS
    )
    results.push(result3)

    // Print results
    console.log('\n=== Benchmark Results ===')
    console.log(`Items: ${ITEM_COUNT}, Iterations: ${ITERATIONS}\n`)
    console.log('| Approach | Total Time (ms) | Items/sec | Avg Time/Item (ms) |')
    console.log('|----------|----------------|-----------|---------------------|')
    for (const r of results) {
      console.log(`| ${r.approach.padEnd(22)} | ${r.totalTime.toString().padStart(14)} | ${r.itemsPerSecond.toString().padStart(9)} | ${r.avgTimePerItem.toString().padStart(19)} |`)
    }
    console.log('')

    // Sanity check - all approaches should complete
    for (const r of results) {
      expect(r.itemsPerSecond).toBeGreaterThan(0)
    }
  })

  it('should measure scope.run() overhead', async () => {
    // This test measures the overhead of scope.run() calls
    // by comparing direct iteration vs scope.run() iteration

    const itemCount = 1000
    const iterations = 5

    // Direct iteration (baseline)
    const directTimes: number[] = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await run(function* () {
        const { stream } = createCountingGenerator({ maxCount: itemCount })
        const subscription = yield* stream
        for (let j = 0; j < itemCount; j++) {
          yield* subscription.next()
        }
      })
      directTimes.push(performance.now() - start)
    }

    // Bridge iteration (with scope.run overhead)
    const bridgeTimes: number[] = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await run(function* () {
        const { stream } = createCountingGenerator({ maxCount: itemCount })
        const response = yield* createReadableStreamBridge(stream)
        const reader = response.body!.getReader()
        for (let j = 0; j < itemCount; j++) {
          yield* call(() => reader.read())
        }
        reader.releaseLock()
      })
      bridgeTimes.push(performance.now() - start)
    }

    const avgDirect = directTimes.reduce((a, b) => a + b, 0) / iterations
    const avgBridge = bridgeTimes.reduce((a, b) => a + b, 0) / iterations
    const overhead = avgBridge - avgDirect
    const overheadPercent = (overhead / avgDirect) * 100

    console.log('\n=== scope.run() Overhead ===')
    console.log(`Direct iteration avg: ${avgDirect.toFixed(2)}ms`)
    console.log(`Bridge iteration avg: ${avgBridge.toFixed(2)}ms`)
    console.log(`Overhead: ${overhead.toFixed(2)}ms (${overheadPercent.toFixed(1)}%)`)
    console.log('')

    // The bridge has significant overhead due to scope.run() per read
    // This is expected - the question is whether it matters in practice
    console.log(`\nNote: Bridge overhead is ${overheadPercent.toFixed(0)}% of direct iteration.`)
    console.log('This is expected due to scope.run() per read().')
    console.log('')

    // Just verify both complete successfully
    expect(avgDirect).toBeGreaterThan(0)
    expect(avgBridge).toBeGreaterThan(0)
  })
})

describe('HTTP Throughput Benchmark', () => {
  const ITEM_COUNT = 100
  const ITERATIONS = 5

  async function benchmarkHTTP(
    name: string,
    handler: (req: Request) => Operation<Response>
  ): Promise<BenchmarkResult> {
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
    const port = address.port

    const times: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now()
      const response = await fetch(`http://localhost:${port}/stream`)
      const text = await response.text()
      times.push(performance.now() - start)
    }

    await new Promise<void>((resolve) => server.close(() => resolve()))

    const totalTime = times.reduce((a, b) => a + b, 0)
    return {
      approach: name,
      totalTime: Math.round(totalTime * 100) / 100,
      itemCount: ITEM_COUNT,
      itemsPerSecond: Math.round((ITEM_COUNT * ITERATIONS / totalTime) * 1000),
      avgTimePerItem: Math.round((totalTime / ITERATIONS / ITEM_COUNT) * 1000) / 1000,
    }
  }

  it('should benchmark HTTP throughput for all approaches', async () => {
    const results: BenchmarkResult[] = []

    // Approach 1
    const result1 = await benchmarkHTTP(
      'ReadableStream Bridge (HTTP)',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        return yield* createReadableStreamBridge(stream)
      }
    )
    results.push(result1)

    // Approach 2
    const result2 = await benchmarkHTTP(
      'AsyncIterable Response (HTTP)',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        return yield* createAsyncIterableResponse(stream)
      }
    )
    results.push(result2)

    // Approach 3
    const result3 = await benchmarkHTTP(
      'Scope-Captured Stream (HTTP)',
      function* () {
        const { stream } = createCountingGenerator({ maxCount: ITEM_COUNT })
        const result = yield* createScopeCapturedStream(stream)
        return result.response
      }
    )
    results.push(result3)

    console.log('\n=== HTTP Throughput Benchmark ===')
    console.log(`Items: ${ITEM_COUNT}, Iterations: ${ITERATIONS}\n`)
    console.log('| Approach | Total Time (ms) | Items/sec | Avg Time/Item (ms) |')
    console.log('|----------|----------------|-----------|---------------------|')
    for (const r of results) {
      console.log(`| ${r.approach.padEnd(26)} | ${r.totalTime.toString().padStart(14)} | ${r.itemsPerSecond.toString().padStart(9)} | ${r.avgTimePerItem.toString().padStart(19)} |`)
    }
    console.log('')

    for (const r of results) {
      expect(r.itemsPerSecond).toBeGreaterThan(0)
    }
  })
})
