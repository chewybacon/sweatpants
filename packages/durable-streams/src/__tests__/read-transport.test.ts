import type { Operation, Subscription } from 'effection'
import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import { createInMemoryBufferStore } from '../in-memory-store.ts'
import type { ProtocolHandlerContext, ProtocolSetupResult } from '../http-types.ts'
import { createStreamETag, toOffsetString } from '../protocol-headers.ts'
import {
  createHeadMetadataResponse,
  createProtocolReadResponse,
} from '../read-transport.ts'
import type { SessionHandle, SessionRegistry } from '../types.ts'

const log = {
  debug: () => {},
}

function normalizeSetupResult(result: ProtocolSetupResult): {
  subscription: Subscription<string, void>
  cleanup?: () => Operation<void>
} {
  if ('next' in result) {
    return { subscription: result }
  }

  return result
}

function createContext(url: string, headers?: HeadersInit): ProtocolHandlerContext {
  return {
    request: new Request(url, { headers }),
    headers: new Headers(),
    status: 200,
  }
}

describe('read-transport', () => {
  it('returns 404 for HEAD metadata on missing session', async () => {
    await run(function* () {
      const registry: SessionRegistry<string> = {
        *acquire(): Operation<SessionHandle<string>> {
          throw new Error('not found')
        },
        *release(): Operation<void> {},
      }

      const ctx = createContext('http://example.test/sessions/missing')
      const result = yield* createHeadMetadataResponse(ctx, registry, 'missing', 0)
      const setup = normalizeSetupResult(result)
      const next = yield* setup.subscription.next()

      expect(ctx.status).toBe(404)
      expect(next.done).toBe(true)
    })
  })

  it('returns metadata headers for HEAD and releases session on cleanup', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const buffer = yield* bufferStore.create('session-1')
      yield* buffer.append(['one'])
      yield* buffer.complete()

      let releaseCount = 0
      const session: SessionHandle<string> = {
        id: 'session-1',
        buffer,
        *status() {
          return 'complete'
        },
      }

      const registry: SessionRegistry<string> = {
        *acquire() {
          return session
        },
        *release() {
          releaseCount += 1
        },
      }

      const ctx = createContext('http://example.test/sessions/session-1')
      const result = yield* createHeadMetadataResponse(ctx, registry, 'session-1', 0)
      const setup = normalizeSetupResult(result)

      expect(ctx.status).toBe(200)
      expect(ctx.headers.get('ETag')).toBe(createStreamETag('session-1', 0, { tailOffset: 1, closed: true }))
      expect(ctx.headers.get('Stream-Next-Offset')).toBe(toOffsetString(1))
      expect(ctx.headers.get('Stream-Closed')).toBeNull()

      if (setup.cleanup) {
        yield* setup.cleanup()
      }
      expect(releaseCount).toBe(1)
    })
  })

  it('returns empty JSON snapshot for offset=now without live mode', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const buffer = yield* bufferStore.create('session-2')
      yield* buffer.append(['one'])

      let releaseCount = 0
      const session: SessionHandle<string> = {
        id: 'session-2',
        buffer,
        *status() {
          return 'streaming'
        },
      }

      const registry: SessionRegistry<string> = {
        *acquire() {
          return session
        },
        *release() {
          releaseCount += 1
        },
      }

      const ctx = createContext('http://example.test/sessions/session-2?offset=now', {
        Accept: 'application/json',
      })

      const result = yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId: 'session-2',
        startLSN: 0,
        isReconnect: true,
        parsedOffset: { value: null, isNow: true },
        liveMode: undefined,
        timeoutMs: 10,
        log,
      })

      const setup = normalizeSetupResult(result)
      const first = yield* setup.subscription.next()
      const second = yield* setup.subscription.next()

      expect(ctx.headers.get('Content-Type')).toBe('application/json')
      expect(first.done).toBe(false)
      expect(first.value).toBe('[]')
      expect(second.done).toBe(true)

      if (setup.cleanup) {
        yield* setup.cleanup()
      }
      expect(releaseCount).toBe(1)
    })
  })

  it('returns 304 when etag matches and stream is up to date', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const buffer = yield* bufferStore.create('session-3')
      yield* buffer.append(['one'])

      const etag = createStreamETag('session-3', 1, { tailOffset: 1, closed: false })
      let releaseCount = 0

      const session: SessionHandle<string> = {
        id: 'session-3',
        buffer,
        *status() {
          return 'streaming'
        },
      }

      const registry: SessionRegistry<string> = {
        *acquire() {
          return session
        },
        *release() {
          releaseCount += 1
        },
      }

      const ctx = createContext('http://example.test/sessions/session-3?offset=1', {
        'If-None-Match': etag,
      })

      const result = yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId: 'session-3',
        startLSN: 1,
        isReconnect: true,
        parsedOffset: { value: 1, isNow: false },
        liveMode: undefined,
        timeoutMs: 10,
        log,
      })

      const setup = normalizeSetupResult(result)
      const next = yield* setup.subscription.next()

      expect(ctx.status).toBe(304)
      expect(next.done).toBe(true)

      if (setup.cleanup) {
        yield* setup.cleanup()
      }
      expect(releaseCount).toBe(1)
    })
  })

  it('returns 204 up-to-date on long-poll timeout with cursor', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const buffer = yield* bufferStore.create('session-4')

      let releaseCount = 0
      const session: SessionHandle<string> = {
        id: 'session-4',
        buffer,
        *status() {
          return 'streaming'
        },
      }

      const registry: SessionRegistry<string> = {
        *acquire() {
          return session
        },
        *release() {
          releaseCount += 1
        },
      }

      const ctx = createContext('http://example.test/sessions/session-4?live=long-poll')

      const result = yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId: 'session-4',
        startLSN: 0,
        isReconnect: true,
        parsedOffset: { value: 0, isNow: false },
        liveMode: 'long-poll',
        timeoutMs: 1,
        log,
      })

      const setup = normalizeSetupResult(result)
      const next = yield* setup.subscription.next()

      expect(ctx.status).toBe(204)
      expect(ctx.headers.get('Stream-Up-To-Date')).toBe('true')
      expect(ctx.headers.get('Stream-Cursor')).toBeTruthy()
      expect(next.done).toBe(true)

      if (setup.cleanup) {
        yield* setup.cleanup()
      }
      expect(releaseCount).toBe(1)
    })
  })

  it('returns SSE stream with event stream content type', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const buffer = yield* bufferStore.create('session-5')
      yield* buffer.append(['hello'])

      let releaseCount = 0
      const session: SessionHandle<string> = {
        id: 'session-5',
        buffer,
        *status() {
          return 'streaming'
        },
      }

      const registry: SessionRegistry<string> = {
        *acquire() {
          return session
        },
        *release() {
          releaseCount += 1
        },
      }

      const ctx = createContext('http://example.test/sessions/session-5?live=sse')

      const result = yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId: 'session-5',
        startLSN: 0,
        isReconnect: true,
        parsedOffset: { value: 0, isNow: false },
        liveMode: 'sse',
        timeoutMs: 10,
        log,
      })

      const setup = normalizeSetupResult(result)
      const first = yield* setup.subscription.next()

      expect(ctx.headers.get('Content-Type')).toBe('text/event-stream')
      expect(first.done).toBe(false)
      expect(first.value).toContain('event: data')
      expect(first.value).toContain('event: control')

      if (setup.cleanup) {
        yield* setup.cleanup()
      }
      expect(releaseCount).toBe(1)
    })
  })
})
