/**
 * Effection ↔ Web Stream Bridge Tests
 *
 * This test file explores how to bridge effection's pull-based streaming
 * with the Web Streams API (ReadableStream).
 *
 * The challenge:
 * - Effection uses generator-based Operations with `yield*`
 * - Web Streams use `pull(controller)` callbacks
 * - We need to bridge these two worlds
 *
 * The goal:
 * - Create a ReadableStream that pulls from our effection-based TokenBuffer
 * - Make it work with standard Response objects
 * - Allow a "client" to read from it like a normal fetch response
 */
import { describe, it, expect } from './vitest-effection.ts'
import { spawn, sleep, call, useScope } from 'effection'
import type { Operation, Subscription, Scope } from 'effection'
import type { TokenFrame } from '../types.ts'
import {
  createInMemoryBuffer,
  createPullStream,
  createWebStreamFromBuffer,
} from './test-utils.ts'

// =============================================================================
// ALTERNATIVE APPROACH: Pumper with async queue (for exploration)
// =============================================================================

interface AsyncQueue<T> {
  push(value: T): void
  pull(): Promise<T | null>
  close(): void
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = []
  let closed = false
  let resolver: ((value: T | null) => void) | null = null

  return {
    push(value: T) {
      if (resolver) {
        resolver(value)
        resolver = null
      } else {
        items.push(value)
      }
    },
    pull(): Promise<T | null> {
      if (items.length > 0) {
        return Promise.resolve(items.shift()!)
      }
      if (closed) {
        return Promise.resolve(null)
      }
      return new Promise((resolve) => {
        resolver = resolve
      })
    },
    close() {
      closed = true
      if (resolver) {
        resolver(null)
        resolver = null
      }
    },
  }
}

function* createWebStreamFromBuffer_v2(
  buffer: ReturnType<typeof createInMemoryBuffer<string>>,
  startLSN = 0
): Operation<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder()
  const queue = createAsyncQueue<TokenFrame<string>>()

  // Spawn pumper that reads from effection stream and pushes to queue
  yield* spawn(function* () {
    const subscription: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, startLSN)

    while (true) {
      const result = yield* subscription.next()
      if (result.done) {
        queue.close()
        break
      }
      queue.push(result.value as TokenFrame<string>)
    }
  })

  // Create web stream that pulls from queue
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const frame = await queue.pull()
      if (frame === null) {
        controller.close()
      } else {
        const json = JSON.stringify(frame) + '\n'
        controller.enqueue(encoder.encode(json))
      }
    },
  })

  return stream
}

// =============================================================================
// TESTS
// =============================================================================

describe('Effection ↔ Web Stream Bridge', () => {
  describe('Approach 1: scope.run() in pull() (library implementation)', () => {
    it('should create a readable stream from a buffer', function* () {
      const buffer = createInMemoryBuffer<string>('bridge-v1-1')
      const scope: Scope = yield* useScope()

      // Populate buffer
      yield* buffer.append(['Hello', ' ', 'world'])
      yield* buffer.complete()

      // Create web stream using library implementation
      const webStream = createWebStreamFromBuffer(scope, buffer)

      // Read from web stream
      const reader = webStream.getReader()
      const decoder = new TextDecoder()
      const frames: TokenFrame<string>[] = []

      while (true) {
        const { done, value } = yield* call(() => reader.read())
        if (done) break
        const line = decoder.decode(value).trim()
        if (line) {
          frames.push(JSON.parse(line))
        }
      }

      expect(frames).toHaveLength(3)
      expect(frames[0]?.token).toBe('Hello')
      expect(frames[0]?.lsn).toBe(1)
      expect(frames[1]?.token).toBe(' ')
      expect(frames[1]?.lsn).toBe(2)
      expect(frames[2]?.token).toBe('world')
      expect(frames[2]?.lsn).toBe(3)
    })

    it('should work with streaming buffer (tokens arrive over time)', function* () {
      const buffer = createInMemoryBuffer<string>('bridge-v1-2')
      const scope: Scope = yield* useScope()

      // Start web stream before buffer is populated
      const webStream = createWebStreamFromBuffer(scope, buffer)
      const reader = webStream.getReader()
      const decoder = new TextDecoder()

      // Spawn a task to populate buffer with delays
      yield* spawn(function* () {
        yield* sleep(10)
        yield* buffer.append(['Hello'])
        yield* sleep(10)
        yield* buffer.append([' world'])
        yield* sleep(10)
        yield* buffer.complete()
      })

      // Read from web stream
      const frames: TokenFrame<string>[] = []
      while (true) {
        const { done, value } = yield* call(() => reader.read())
        if (done) break
        const line = decoder.decode(value).trim()
        if (line) {
          frames.push(JSON.parse(line))
        }
      }

      expect(frames).toHaveLength(2)
      expect(frames[0]?.token).toBe('Hello')
      expect(frames[1]?.token).toBe(' world')
    })

    it('should work with Response object', function* () {
      const buffer = createInMemoryBuffer<string>('bridge-v1-3')
      const scope: Scope = yield* useScope()

      yield* buffer.append(['test', 'response'])
      yield* buffer.complete()

      const webStream = createWebStreamFromBuffer(scope, buffer)
      const response = new Response(webStream, {
        headers: { 'content-type': 'application/x-ndjson' },
      })

      expect(response.headers.get('content-type')).toBe('application/x-ndjson')

      const text = yield* call(() => response.text())
      const lines = text.trim().split('\n')

      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).token).toBe('test')
      expect(JSON.parse(lines[1]!).token).toBe('response')
    })
  })

  describe('Approach 2: Pumper with async queue (alternative)', () => {
    it('should create a readable stream from a buffer', function* () {
      const buffer = createInMemoryBuffer<string>('bridge-v2-1')

      // Populate buffer
      yield* buffer.append(['Hello', ' ', 'world'])
      yield* buffer.complete()

      // Create web stream (this spawns the pumper)
      const webStream = yield* createWebStreamFromBuffer_v2(buffer)

      // Read from web stream
      const reader = webStream.getReader()
      const decoder = new TextDecoder()
      const frames: TokenFrame<string>[] = []

      while (true) {
        const { done, value } = yield* call(() => reader.read())
        if (done) break
        const line = decoder.decode(value).trim()
        if (line) {
          frames.push(JSON.parse(line))
        }
      }

      expect(frames).toHaveLength(3)
      expect(frames[0]?.token).toBe('Hello')
      expect(frames[1]?.token).toBe(' ')
      expect(frames[2]?.token).toBe('world')
    })

    it('should work with streaming buffer (tokens arrive over time)', function* () {
      const buffer = createInMemoryBuffer<string>('bridge-v2-2')

      // Create web stream before buffer is populated
      const webStream = yield* createWebStreamFromBuffer_v2(buffer)
      const reader = webStream.getReader()
      const decoder = new TextDecoder()

      // Spawn a task to populate buffer with delays
      yield* spawn(function* () {
        yield* sleep(10)
        yield* buffer.append(['Hello'])
        yield* sleep(10)
        yield* buffer.append([' world'])
        yield* sleep(10)
        yield* buffer.complete()
      })

      // Read from web stream
      const frames: TokenFrame<string>[] = []
      while (true) {
        const { done, value } = yield* call(() => reader.read())
        if (done) break
        const line = decoder.decode(value).trim()
        if (line) {
          frames.push(JSON.parse(line))
        }
      }

      expect(frames).toHaveLength(2)
      expect(frames[0]?.token).toBe('Hello')
      expect(frames[1]?.token).toBe(' world')
    })
  })

  describe('Client simulation helpers', () => {
    it('should provide a helper to consume response as TokenFrames', function* () {
      const buffer = createInMemoryBuffer<string>('client-sim-1')
      const scope: Scope = yield* useScope()

      yield* buffer.append(['Hello', 'world'])
      yield* buffer.complete()

      const webStream = createWebStreamFromBuffer(scope, buffer)
      const response = new Response(webStream)

      // Helper function to consume response
      async function consumeTokenFrames(res: Response): Promise<TokenFrame<string>[]> {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const frames: TokenFrame<string>[] = []
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            // Process any remaining buffer
            if (buffer.trim()) {
              frames.push(JSON.parse(buffer.trim()))
            }
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()! // Keep incomplete line
          for (const line of lines) {
            if (line.trim()) {
              frames.push(JSON.parse(line))
            }
          }
        }
        return frames
      }

      const frames = yield* call(() => consumeTokenFrames(response))

      expect(frames).toHaveLength(2)
      expect(frames[0]?.token).toBe('Hello')
      expect(frames[0]?.lsn).toBe(1)
      expect(frames[1]?.token).toBe('world')
      expect(frames[1]?.lsn).toBe(2)
    })
  })
})
