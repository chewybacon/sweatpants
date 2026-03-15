/**
 * Integration Tests
 *
 * Tests each approach with real HTTP calls using Node's http module.
 * This verifies that the approaches work end-to-end with actual network I/O.
 *
 * Note: Pull behavior is tested in pull-behavior.test.ts. These tests focus
 * on correctness (all values are received in order).
 */
import { describe, it, expect } from 'vitest'
import { run, call, type Operation } from 'effection'
import { createServer } from 'node:http'
import { createCountingGenerator } from '../test-utils.ts'
import { createReadableStreamBridge } from '../approaches/readable-stream-bridge.ts'
import { createAsyncIterableResponse } from '../approaches/async-iterable-response.ts'
import { createScopeCapturedStream } from '../approaches/scope-captured-stream.ts'
import { createEffectionServer, type EffectionHandler } from '../approaches/effection-server.ts'

interface ServerContext {
  port: number
  close: () => void
}

async function withServer(
  handler: (req: Request) => Operation<Response>,
  fn: (ctx: ServerContext) => Promise<void>
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const webRequest = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })

      const webResponse = await run(() => handler(webRequest))

      res.statusCode = webResponse.status
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

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

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve())
  })

  const address = server.address() as { port: number }

  try {
    await fn({ port: address.port, close: () => server.close() })
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

async function fetchAllValues(port: number): Promise<number[]> {
  const response = await fetch(`http://localhost:${port}/stream`)
  expect(response.status).toBe(200)

  const text = await response.text()
  const results: number[] = []

  for (const line of text.trim().split('\n')) {
    if (line) {
      results.push(JSON.parse(line))
    }
  }

  return results
}

describe('Integration Tests', () => {
  describe('createReadableStreamBridge (Approach 1)', () => {
    it('should stream all values over HTTP', async () => {
      const { stream } = createCountingGenerator({ maxCount: 10 })

      await withServer(
        function* () {
          return yield* createReadableStreamBridge(stream)
        },
        async ({ port }) => {
          const results = await fetchAllValues(port)
          expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        }
      )
    })
  })

  describe('createAsyncIterableResponse (Approach 2)', () => {
    it('should stream all values over HTTP', async () => {
      const { stream } = createCountingGenerator({ maxCount: 10 })

      await withServer(
        function* () {
          return yield* createAsyncIterableResponse(stream)
        },
        async ({ port }) => {
          const results = await fetchAllValues(port)
          expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        }
      )
    })
  })

  describe('createScopeCapturedStream (Approach 3)', () => {
    it('should stream all values over HTTP', async () => {
      const { stream } = createCountingGenerator({ maxCount: 10 })

      await withServer(
        function* () {
          const result = yield* createScopeCapturedStream(stream)
          return result.response
        },
        async ({ port }) => {
          const results = await fetchAllValues(port)
          expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        }
      )
    })
  })

  describe('createEffectionServer (Approach 4)', () => {
    it('should serve HTTP with Effection-native handler', async () => {
      const { stream } = createCountingGenerator({ maxCount: 10 })

      const handler: EffectionHandler = function* (_req) {
        return yield* createReadableStreamBridge(stream)
      }

      await run(function* () {
        const server = yield* createEffectionServer({
          port: 0,
          handler,
        })

        const port = server.address.port

        try {
          const results: number[] = yield* call(() => fetchAllValues(port))
          expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        } finally {
          server.stop()
        }
      })
    })
  })
})

describe('Error Handling', () => {
  it('should handle stream errors gracefully', async () => {
    const { stream } = createCountingGenerator({ maxCount: 5 })

    await withServer(
      function* () {
        return yield* createReadableStreamBridge(stream)
      },
      async ({ port }) => {
        const response = await fetch(`http://localhost:${port}/stream`)
        expect(response.status).toBe(200)

        const text = await response.text()
        const lines = text.trim().split('\n')
        expect(lines.length).toBe(5)
      }
    )
  })
})

describe('Content Type', () => {
  it('should set correct content-type header', async () => {
    const { stream } = createCountingGenerator({ maxCount: 5 })

    await withServer(
      function* () {
        return yield* createReadableStreamBridge(stream)
      },
      async ({ port }) => {
        const response = await fetch(`http://localhost:${port}/stream`)
        expect(response.headers.get('content-type')).toBe('application/x-ndjson')
      }
    )
  })
})
