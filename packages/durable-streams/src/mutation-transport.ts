import { call, type Operation } from 'effection'

import type { ProtocolHandlerContext, ProtocolSetupResult } from './http-types.ts'
import { toOffsetString } from './protocol-headers.ts'
import { createEmptyStream } from './read-transport.ts'
import type { SessionRegistryStore, TokenBufferStore } from './types.ts'

interface LoggerLike {
  debug(data: unknown, message?: string): void
}

interface MutationParams {
  ctx: ProtocolHandlerContext
  sessionId: string
  method: 'PUT' | 'POST' | 'DELETE'
  bufferStore: TokenBufferStore<string>
  registryStore: SessionRegistryStore
  log: LoggerLike
}

function isCloseRequest(request: Request): boolean {
  const value = request.headers.get('stream-closed')
  return value?.toLowerCase() === 'true'
}

function applyMutationHeaders(
  headers: Headers,
  tailOffset: number,
  closed: boolean,
): void {
  headers.set('Stream-Next-Offset', toOffsetString(tailOffset))
  if (closed) {
    headers.set('Stream-Closed', 'true')
  }
}

export function* createProtocolMutationResponse(
  params: MutationParams,
): Operation<ProtocolSetupResult> {
  const { ctx, sessionId, method, bufferStore, registryStore, log } = params

  if (method === 'PUT') {
    const existing = yield* bufferStore.get(sessionId)
    let buffer = existing

    if (!buffer) {
      buffer = yield* bufferStore.create(sessionId)
      const entry = yield* registryStore.get(sessionId)
      if (!entry) {
        yield* registryStore.set(sessionId, {
          refCount: 0,
          createdAt: Date.now(),
        })
      }
      ctx.status = 201
    } else {
      ctx.status = 200
    }

    const { lsn } = yield* buffer.read(Number.MAX_SAFE_INTEGER)
    const closed = yield* buffer.isComplete()
    applyMutationHeaders(ctx.headers, lsn, closed)

    return {
      subscription: yield* createEmptyStream(),
    }
  }

  if (method === 'DELETE') {
    const existingBuffer = yield* bufferStore.get(sessionId)
    if (existingBuffer) {
      const complete = yield* existingBuffer.isComplete()
      if (!complete) {
        yield* existingBuffer.complete()
      }
    }

    yield* registryStore.delete(sessionId)
    yield* bufferStore.delete(sessionId)
    ctx.status = 204
    return {
      subscription: yield* createEmptyStream(),
    }
  }

  const buffer = yield* bufferStore.get(sessionId)
  if (!buffer) {
    ctx.status = 404
    return {
      subscription: yield* createEmptyStream(),
    }
  }

  const close = isCloseRequest(ctx.request)
  const body = yield* call(() => ctx.request.text())
  if (body.length === 0 && !close) {
    log.debug({ sessionId }, 'append without body rejected')
    ctx.status = 400
    return {
      subscription: yield* createEmptyStream(),
    }
  }

  if (body.length > 0) {
    yield* buffer.append([body])
  }

  if (close) {
    yield* buffer.complete()
  }

  const { lsn } = yield* buffer.read(Number.MAX_SAFE_INTEGER)
  const closed = yield* buffer.isComplete()
  applyMutationHeaders(ctx.headers, lsn, closed)
  ctx.status = 204

  return {
    subscription: yield* createEmptyStream(),
  }
}
