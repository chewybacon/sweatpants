import { race, resource, sleep, type Operation, type Stream } from 'effection'

import type { ProtocolHandlerContext, ProtocolSetupResult } from './http-types.ts'
import {
  applySnapshotHeaders,
  createStreamCursor,
  createStreamETag,
  toOffsetString,
  type LiveMode,
  type ParsedOffset,
} from './protocol-headers.ts'
import { createPullStream } from './pull-stream.ts'
import { createSSEEventStream } from './sse-formatter.ts'
import type { SessionHandle, SessionRegistry, TokenBuffer } from './types.ts'

interface LoggerLike {
  debug(data: unknown, message?: string): void
}

interface ReadTransportParams {
  ctx: ProtocolHandlerContext
  registry: SessionRegistry<string>
  session: SessionHandle<string>
  sessionId: string
  startLSN: number
  isReconnect: boolean
  parsedOffset: ParsedOffset
  liveMode: LiveMode | undefined
  timeoutMs: number
  log: LoggerLike
}

export function createEmptyStream(): Stream<string, void> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        return { done: true, value: undefined }
      },
    })
  })
}

function createSingleChunkStream(chunk: string): Stream<string, void> {
  return resource(function* (provide) {
    let emitted = false
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (emitted) {
          return { done: true, value: undefined }
        }
        emitted = true
        return { done: false, value: chunk }
      },
    })
  })
}

function wantsJsonSnapshot(request: Request): boolean {
  const accept = request.headers.get('accept')
  if (!accept) {
    return false
  }
  return accept.toLowerCase().includes('application/json')
}

function* readStreamMetadata(
  session: SessionHandle<string>,
): Operation<{ tailOffset: number; closed: boolean }> {
  const { lsn } = yield* session.buffer.read(Number.MAX_SAFE_INTEGER)
  const closed = yield* session.buffer.isComplete()
  return { tailOffset: lsn, closed }
}

function createDurableEventStream(
  buffer: TokenBuffer<string>,
  startLSN: number,
): Stream<string, void> {
  return resource(function* (provide) {
    const pullStream = yield* createPullStream(buffer, startLSN)
    let lastLSN = startLSN
    let errorEmitted = false

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (errorEmitted) {
          return { done: true, value: undefined }
        }

        try {
          const result = yield* pullStream.next()
          if (result.done) {
            return { done: true, value: undefined }
          }
          const frame = result.value
          lastLSN = frame.lsn
          const durableEvent = {
            lsn: frame.lsn,
            event: JSON.parse(frame.token),
          }
          return { done: false, value: JSON.stringify(durableEvent) }
        } catch (error) {
          errorEmitted = true
          const errorEvent = {
            lsn: lastLSN + 1,
            event: {
              type: 'error',
              message: error instanceof Error ? error.message : 'Unknown error',
              recoverable: false,
            },
          }
          return { done: false, value: JSON.stringify(errorEvent) }
        }
      },
    })
  })
}

export function* createHeadMetadataResponse(
  ctx: ProtocolHandlerContext,
  registry: SessionRegistry<string>,
  sessionId: string,
  startLSN: number,
): Operation<ProtocolSetupResult> {
  let session: SessionHandle<string>

  try {
    session = yield* registry.acquire(sessionId)
  } catch {
    ctx.status = 404
    return yield* createEmptyStream()
  }

  try {
    const metadata = yield* readStreamMetadata(session)
    const etag = createStreamETag(sessionId, startLSN, metadata)

    ctx.headers.set('ETag', etag)
    applySnapshotHeaders(ctx.headers, startLSN, metadata)
    ctx.status = 200

    return {
      subscription: yield* createEmptyStream(),
      cleanup: function* () {
        yield* registry.release(sessionId)
      },
    }
  } catch (error) {
    yield* registry.release(sessionId)
    throw error
  }
}

export function* createProtocolReadResponse(
  params: ReadTransportParams,
): Operation<ProtocolSetupResult> {
  const {
    ctx,
    registry,
    session,
    sessionId,
    startLSN,
    isReconnect,
    parsedOffset,
    liveMode,
    timeoutMs,
    log,
  } = params
  const jsonSnapshot = wantsJsonSnapshot(ctx.request)

  let effectiveStartLSN = isReconnect ? startLSN : 0
  log.debug({ sessionId, effectiveStartLSN }, 'creating durable event stream')

  const metadata = yield* readStreamMetadata(session)
  if (parsedOffset.isNow) {
    effectiveStartLSN = metadata.tailOffset
  }

  const etag = createStreamETag(sessionId, effectiveStartLSN, metadata)
  ctx.headers.set('ETag', etag)
  applySnapshotHeaders(ctx.headers, effectiveStartLSN, metadata)

  if (parsedOffset.isNow && liveMode === undefined) {
    if (jsonSnapshot) {
      ctx.headers.set('Content-Type', 'application/json')
      return {
        subscription: yield* createSingleChunkStream('[]'),
        cleanup: function* () {
          yield* registry.release(sessionId)
        },
      }
    }

    return {
      subscription: yield* createEmptyStream(),
      cleanup: function* () {
        yield* registry.release(sessionId)
      },
    }
  }

  if (liveMode === 'long-poll') {
    const ensureCursor = () => {
      if (!metadata.closed) {
        ctx.headers.set('Stream-Cursor', createStreamCursor())
      }
    }

    if (effectiveStartLSN >= metadata.tailOffset) {
      if (metadata.closed) {
        ctx.status = 204
        ctx.headers.set('Stream-Closed', 'true')
        ctx.headers.set('Stream-Up-To-Date', 'true')
        ctx.headers.set('Stream-Next-Offset', toOffsetString(metadata.tailOffset))
        return {
          subscription: yield* createEmptyStream(),
          cleanup: function* () {
            yield* registry.release(sessionId)
          },
        }
      }

      const waitResult = yield* race([
        (function* (): Operation<{ type: 'changed' }> {
          yield* session.buffer.waitForChange(effectiveStartLSN)
          return { type: 'changed' }
        })(),
        (function* (): Operation<{ type: 'timeout' }> {
          yield* sleep(timeoutMs)
          return { type: 'timeout' }
        })(),
      ])

      const afterWaitMetadata = yield* readStreamMetadata(session)
      ctx.headers.set('Stream-Next-Offset', toOffsetString(afterWaitMetadata.tailOffset))

      if (afterWaitMetadata.closed && effectiveStartLSN >= afterWaitMetadata.tailOffset) {
        ctx.status = 204
        ctx.headers.set('Stream-Closed', 'true')
        ctx.headers.set('Stream-Up-To-Date', 'true')
        return {
          subscription: yield* createEmptyStream(),
          cleanup: function* () {
            yield* registry.release(sessionId)
          },
        }
      }

      if (waitResult.type === 'timeout' && effectiveStartLSN >= afterWaitMetadata.tailOffset) {
        ctx.status = 204
        ctx.headers.set('Stream-Up-To-Date', 'true')
        if (!afterWaitMetadata.closed) {
          ctx.headers.set('Stream-Cursor', createStreamCursor())
        }
        return {
          subscription: yield* createEmptyStream(),
          cleanup: function* () {
            yield* registry.release(sessionId)
          },
        }
      }
    }

    ensureCursor()
  }

  const ifNoneMatch = ctx.request.headers.get('if-none-match')
  if (ifNoneMatch === etag && effectiveStartLSN >= metadata.tailOffset) {
    ctx.status = 304
    return {
      subscription: yield* createEmptyStream(),
      cleanup: function* () {
        log.debug({ sessionId }, 'releasing session after 304')
        yield* registry.release(sessionId)
      },
    }
  }

  if (liveMode === undefined && effectiveStartLSN >= metadata.tailOffset && jsonSnapshot) {
    ctx.headers.set('Content-Type', 'application/json')
    return {
      subscription: yield* createSingleChunkStream('[]'),
      cleanup: function* () {
        log.debug({ sessionId }, 'releasing session after empty json snapshot')
        yield* registry.release(sessionId)
      },
    }
  }

  if (liveMode === 'sse') {
    ctx.headers.set('Content-Type', 'text/event-stream')
    const sseStream = createSSEEventStream(session.buffer, effectiveStartLSN)
    const sseSubscription = yield* sseStream
    return {
      subscription: sseSubscription,
      cleanup: function* () {
        log.debug({ sessionId }, 'releasing session after SSE')
        yield* registry.release(sessionId)
      },
    }
  }

  const durableStream = createDurableEventStream(session.buffer, effectiveStartLSN)
  const durableSubscription = yield* durableStream
  log.debug({ sessionId }, 'durable event subscription created')

  return {
    subscription: durableSubscription,
    cleanup: function* () {
      log.debug({ sessionId }, 'releasing session')
      yield* registry.release(sessionId)
    },
  }
}
