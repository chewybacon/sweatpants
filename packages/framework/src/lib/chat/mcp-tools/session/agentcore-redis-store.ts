import { call, sleep, type Operation } from 'effection'
import type {
  AgentCoreToolEvent,
  AgentCoreToolSessionHandle,
  SerializableToolSessionHandleStore,
  ToolSessionEventStore,
} from './agentcore-types.ts'

interface RedisStreamEntry {
  id: string
  message: Record<string, string>
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: unknown): Promise<unknown>
  del(key: string | string[]): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
  sAdd(key: string, members: string | string[]): Promise<unknown>
  sRem(key: string, members: string | string[]): Promise<unknown>
  sMembers(key: string): Promise<string[]>
  xAdd(key: string, id: string, message: Record<string, string>): Promise<string>
  xRange(key: string, start: string, end: string): Promise<RedisStreamEntry[]>
}

export interface AgentCoreRedisStoreOptions {
  keyPrefix?: string
  defaultTtlSeconds?: number
}

function secondsUntil(iso: string, fallback: number): number {
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return fallback
  return Math.max(1, Math.ceil(ms / 1000))
}

function isExpired(handle: AgentCoreToolSessionHandle): boolean {
  return Date.parse(handle.expiresAt) <= Date.now()
}

function parseHandle(raw: string): AgentCoreToolSessionHandle {
  return JSON.parse(raw) as AgentCoreToolSessionHandle
}

function isTerminalEvent(event: AgentCoreToolEvent): boolean {
  return event.type === 'result' || event.type === 'error' || event.type === 'cancelled'
}

export function createRedisAgentCoreToolSessionHandleStore(
  client: RedisLikeClient,
  options: AgentCoreRedisStoreOptions = {}
): SerializableToolSessionHandleStore<AgentCoreToolSessionHandle> {
  const prefix = options.keyPrefix ?? 'sp:agentcore:'
  const defaultTtl = options.defaultTtlSeconds ?? 3600

  const handleKey = (sessionId: string) => `${prefix}tool-session:${sessionId}:handle`
  const callKey = (callId: string) => `${prefix}call:${callId}`
  const conversationKey = (conversationId: string) => `${prefix}conversation:${conversationId}:tools`
  const runtimeKey = (runtimeSessionId: string) => `${prefix}runtime-session:${runtimeSessionId}`

  function* writeIndexes(handle: AgentCoreToolSessionHandle): Operation<void> {
    const ttl = secondsUntil(handle.expiresAt, defaultTtl)
    if (handle.callId) {
      yield* call(() => client.set(callKey(handle.callId!), handle.sessionId))
      yield* call(() => client.expire(callKey(handle.callId!), ttl))
    }
    if (handle.conversationId) {
      yield* call(() => client.sAdd(conversationKey(handle.conversationId!), handle.sessionId))
      yield* call(() => client.expire(conversationKey(handle.conversationId!), ttl))
    }
    yield* call(() => client.set(runtimeKey(handle.runtimeSessionId), handle.sessionId))
    yield* call(() => client.expire(runtimeKey(handle.runtimeSessionId), ttl))
  }

  function* readHandle(sessionId: string): Operation<AgentCoreToolSessionHandle | null> {
    const raw = yield* call(() => client.get(handleKey(sessionId)))
    if (!raw) return null
    const handle = parseHandle(raw)
    if (isExpired(handle)) {
      yield* clientDelete(handle)
      return null
    }
    return handle
  }

  function* clientDelete(handle: AgentCoreToolSessionHandle): Operation<void> {
    const keys = [handleKey(handle.sessionId), runtimeKey(handle.runtimeSessionId)]
    if (handle.callId) keys.push(callKey(handle.callId))
    yield* call(() => client.del(keys))
    if (handle.conversationId) {
      yield* call(() => client.sRem(conversationKey(handle.conversationId!), handle.sessionId))
    }
  }

  return {
    *create(handle: AgentCoreToolSessionHandle): Operation<void> {
      const existing = yield* call(() => client.get(handleKey(handle.sessionId)))
      if (existing) throw new Error(`AgentCore tool session already exists: ${handle.sessionId}`)
      const ttl = secondsUntil(handle.expiresAt, defaultTtl)
      yield* call(() => client.set(handleKey(handle.sessionId), JSON.stringify(handle)))
      yield* call(() => client.expire(handleKey(handle.sessionId), ttl))
      yield* writeIndexes(handle)
    },

    *get(sessionId: string): Operation<AgentCoreToolSessionHandle | null> {
      return yield* readHandle(sessionId)
    },

    *update(sessionId: string, patch: Partial<AgentCoreToolSessionHandle>): Operation<AgentCoreToolSessionHandle> {
      const existing = yield* readHandle(sessionId)
      if (!existing) throw new Error(`AgentCore tool session not found: ${sessionId}`)
      const updated: AgentCoreToolSessionHandle = {
        ...existing,
        ...patch,
        sessionId: existing.sessionId,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      }
      const ttl = secondsUntil(updated.expiresAt, defaultTtl)
      yield* call(() => client.set(handleKey(sessionId), JSON.stringify(updated)))
      yield* call(() => client.expire(handleKey(sessionId), ttl))
      yield* writeIndexes(updated)
      return updated
    },

    *delete(sessionId: string): Operation<void> {
      const existing = yield* readHandle(sessionId)
      if (existing) yield* clientDelete(existing)
      else yield* call(() => client.del(handleKey(sessionId)))
    },

    *findByCallId(callId: string): Operation<AgentCoreToolSessionHandle | null> {
      const sessionId = yield* call(() => client.get(callKey(callId)))
      return sessionId ? yield* readHandle(sessionId) : null
    },

    *listByConversation(conversationId: string): Operation<AgentCoreToolSessionHandle[]> {
      const ids = yield* call(() => client.sMembers(conversationKey(conversationId)))
      const result: AgentCoreToolSessionHandle[] = []
      for (const id of ids) {
        const handle = yield* readHandle(id)
        if (handle) result.push(handle)
      }
      return result
    },
  }
}

export function createRedisAgentCoreToolSessionEventStore(
  client: RedisLikeClient,
  options: AgentCoreRedisStoreOptions = {}
): ToolSessionEventStore<AgentCoreToolEvent> {
  const prefix = options.keyPrefix ?? 'sp:agentcore:'
  const defaultTtl = options.defaultTtlSeconds ?? 3600

  const streamKey = (sessionId: string) => `${prefix}tool-session:${sessionId}:events`
  const lsnKey = (sessionId: string) => `${prefix}tool-session:${sessionId}:events:lsn`
  const terminalKey = (sessionId: string) => `${prefix}tool-session:${sessionId}:terminal`
  const dedupKey = (sessionId: string, runtimeEventSeq: number, runtimeEventId: string) => `${prefix}tool-session:${sessionId}:event:${runtimeEventSeq}:${runtimeEventId}`

  function* touch(sessionId: string): Operation<void> {
    yield* call(() => client.expire(streamKey(sessionId), defaultTtl))
    yield* call(() => client.expire(lsnKey(sessionId), defaultTtl))
    yield* call(() => client.expire(terminalKey(sessionId), defaultTtl))
  }

  function parseEntry(entry: RedisStreamEntry): { lsn: number; event: AgentCoreToolEvent } {
    const lsn = Number(entry.message['lsn'] ?? '0')
    const raw = entry.message['event']
    if (!raw) throw new Error('Redis event entry missing event')
    return { lsn, event: JSON.parse(raw) as AgentCoreToolEvent }
  }

  function* markTerminalValue(sessionId: string): Operation<void> {
    yield* call(() => client.set(terminalKey(sessionId), '1'))
    yield* touch(sessionId)
  }

  return {
    *append(sessionId: string, event: AgentCoreToolEvent): Operation<number> {
      const lsn = yield* call(() => client.incr(lsnKey(sessionId)))
      yield* call(() => client.xAdd(streamKey(sessionId), '*', {
        lsn: String(lsn),
        runtimeEventSeq: '0',
        runtimeEventId: `local:${sessionId}:${lsn}`,
        event: JSON.stringify(event),
      }))
      if (isTerminalEvent(event)) yield* markTerminalValue(sessionId)
      yield* touch(sessionId)
      return lsn
    },

    *appendRemoteEvent(sessionId: string, runtimeEventSeq: number, runtimeEventId: string, event: AgentCoreToolEvent): Operation<number> {
      const dkey = dedupKey(sessionId, runtimeEventSeq, runtimeEventId)
      const existing = yield* call(() => client.get(dkey))
      if (existing) {
        const parsed = JSON.parse(existing) as { runtimeEventId: string; event: AgentCoreToolEvent; lsn: number }
        const same = parsed.runtimeEventId === runtimeEventId && JSON.stringify(parsed.event) === JSON.stringify(event)
        if (same) return parsed.lsn
        // Some AgentCore/runtime replay paths can resend the same runtime event
        // id with a changed payload during coroutine resume. Preserve forward
        // progress by appending the changed event locally instead of failing the
        // whole UI stream.
      }

      const lsn = yield* call(() => client.incr(lsnKey(sessionId)))
      yield* call(() => client.xAdd(streamKey(sessionId), '*', {
        lsn: String(lsn),
        runtimeEventSeq: String(runtimeEventSeq),
        runtimeEventId,
        event: JSON.stringify(event),
      }))
      yield* call(() => client.set(dkey, JSON.stringify({ runtimeEventId, event, lsn })))
      yield* call(() => client.expire(dkey, defaultTtl))
      if (isTerminalEvent(event)) yield* markTerminalValue(sessionId)
      yield* touch(sessionId)
      return lsn
    },

    *readAfter(sessionId: string, afterLSN = 0): Operation<{ events: Array<{ lsn: number; event: AgentCoreToolEvent }>; lastLSN: number }> {
      const entries = yield* call(() => client.xRange(streamKey(sessionId), '-', '+'))
      const parsed = entries.map(parseEntry).filter((entry) => entry.lsn > afterLSN)
      const lastRaw = yield* call(() => client.get(lsnKey(sessionId)))
      return { events: parsed, lastLSN: Number(lastRaw ?? '0') }
    },

    *waitForChange(sessionId: string, afterLSN: number, timeoutMs?: number): Operation<void> {
      const started = Date.now()
      while (true) {
        const lastRaw = yield* call(() => client.get(lsnKey(sessionId)))
        const terminalRaw = yield* call(() => client.get(terminalKey(sessionId)))
        if (Number(lastRaw ?? '0') > afterLSN || terminalRaw === '1') return
        if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) return
        yield* sleep(25)
      }
    },

    *markTerminal(sessionId: string): Operation<void> {
      yield* markTerminalValue(sessionId)
    },

    *isTerminal(sessionId: string): Operation<boolean> {
      const raw = yield* call(() => client.get(terminalKey(sessionId)))
      return raw === '1'
    },
  }
}
