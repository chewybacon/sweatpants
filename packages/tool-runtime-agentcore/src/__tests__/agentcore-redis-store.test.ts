// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { run, spawn, sleep } from 'effection'
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  createRedisAgentCoreToolSessionEventStore,
  createRedisAgentCoreToolSessionHandleStore,
} from '../index.ts'
import type { AgentCoreToolSessionHandle, RedisLikeClient } from '../index.ts'

class InMemoryRedisLikeClient implements RedisLikeClient {
  strings = new Map<string, string>()
  sets = new Map<string, Set<string>>()
  streams = new Map<string, Array<{ id: string; message: Record<string, string> }>>()
  expirations = new Map<string, number>()
  counters = new Map<string, number>()
  streamSeq = 0

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string): Promise<unknown> {
    this.strings.set(key, value)
    return 'OK'
  }

  async del(key: string | string[]): Promise<unknown> {
    const keys = Array.isArray(key) ? key : [key]
    for (const k of keys) {
      this.strings.delete(k)
      this.sets.delete(k)
      this.streams.delete(k)
      this.expirations.delete(k)
      this.counters.delete(k)
    }
    return keys.length
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? Number(this.strings.get(key) ?? '0')) + 1
    this.counters.set(key, next)
    this.strings.set(key, String(next))
    return next
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    this.expirations.set(key, Date.now() + seconds * 1000)
    return 1
  }

  async sAdd(key: string, members: string | string[]): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>()
    for (const member of Array.isArray(members) ? members : [members]) set.add(member)
    this.sets.set(key, set)
    return 1
  }

  async sRem(key: string, members: string | string[]): Promise<unknown> {
    const set = this.sets.get(key)
    if (!set) return 0
    for (const member of Array.isArray(members) ? members : [members]) set.delete(member)
    return 1
  }

  async sMembers(key: string): Promise<string[]> {
    if (this.isExpired(key)) return []
    return Array.from(this.sets.get(key) ?? [])
  }

  async xAdd(key: string, id: string, message: Record<string, string>): Promise<string> {
    const stream = this.streams.get(key) ?? []
    const entryId = id === '*' ? `${++this.streamSeq}-0` : id
    stream.push({ id: entryId, message })
    this.streams.set(key, stream)
    return entryId
  }

  async xRange(key: string, _start: string, _end: string): Promise<Array<{ id: string; message: Record<string, string> }>> {
    if (this.isExpired(key)) return []
    return [...(this.streams.get(key) ?? [])]
  }

  private isExpired(key: string): boolean {
    const at = this.expirations.get(key)
    if (at === undefined || at > Date.now()) return false
    this.strings.delete(key)
    this.sets.delete(key)
    this.streams.delete(key)
    this.expirations.delete(key)
    this.counters.delete(key)
    return true
  }
}

function handle(overrides: Partial<AgentCoreToolSessionHandle> = {}): AgentCoreToolSessionHandle {
  const now = new Date().toISOString()
  return {
    kind: 'agentcore-tool-session',
    version: 1,
    protocolVersion: AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
    sessionId: 'session-1',
    toolName: 'tool',
    callId: 'call-1',
    conversationId: 'conversation-1',
    runtimeProfile: 'profile',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test',
    endpointName: 'DEFAULT',
    runtimeSessionId: 'runtime-session-1',
    region: 'us-east-1',
    status: 'running',
    lastEventLsn: 0,
    lastRuntimeEventSeq: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

describe('AgentCore Redis stores', () => {
  it('stores handles and lookup indexes', async () => {
    const client = new InMemoryRedisLikeClient()
    const store = createRedisAgentCoreToolSessionHandleStore(client, { keyPrefix: 'test:' })

    const result = await run(function* () {
      yield* store.create(handle())
      const byId = yield* store.get('session-1')
      const byCall = yield* store.findByCallId('call-1')
      const byConversation = yield* store.listByConversation('conversation-1')
      const updated = yield* store.update('session-1', {
        status: 'awaiting_elicit',
        pendingRequest: { type: 'elicit', elicitId: 'e1' },
      })
      yield* store.delete('session-1')
      const afterDelete = yield* store.get('session-1')
      return { byId, byCall, byConversation, updated, afterDelete }
    })

    expect(result.byId?.sessionId).toBe('session-1')
    expect(result.byCall?.sessionId).toBe('session-1')
    expect(result.byConversation).toHaveLength(1)
    expect(result.updated).toMatchObject({
      status: 'awaiting_elicit',
      pendingRequest: { type: 'elicit', elicitId: 'e1' },
    })
    expect(result.afterDelete).toBeNull()
  })

  it('does not return expired handles', async () => {
    const client = new InMemoryRedisLikeClient()
    const store = createRedisAgentCoreToolSessionHandleStore(client, { keyPrefix: 'test:' })

    const result = await run(function* () {
      yield* store.create(handle({ expiresAt: new Date(Date.now() - 1_000).toISOString() }))
      return yield* store.get('session-1')
    })

    expect(result).toBeNull()
  })

  it('appends, replays, waits, and marks terminal events', async () => {
    const client = new InMemoryRedisLikeClient()
    const store = createRedisAgentCoreToolSessionEventStore(client, { keyPrefix: 'test:' })

    const result = await run(function* () {
      yield* store.append('session-1', { type: 'progress', message: 'one' })
      yield* store.append('session-1', { type: 'progress', message: 'two' })
      const afterOne = yield* store.readAfter('session-1', 1)

      let unblocked = false
      yield* spawn(function* () {
        yield* store.waitForChange('session-1', 2, 500)
        unblocked = true
      })
      yield* sleep(20)
      expect(unblocked).toBe(false)
      yield* store.append('session-1', { type: 'result', result: { ok: true } })
      yield* sleep(50)

      return {
        afterOne,
        unblocked,
        terminal: yield* store.isTerminal('session-1'),
        all: yield* store.readAfter('session-1', 0),
      }
    })

    expect(result.afterOne.events.map(({ event }) => event.type)).toEqual(['progress'])
    expect(result.unblocked).toBe(true)
    expect(result.terminal).toBe(true)
    expect(result.all.events.map(({ event }) => event.type)).toEqual(['progress', 'progress', 'result'])
  })

  it('deduplicates exact remote events and allows same sequence with different runtime ids', async () => {
    const client = new InMemoryRedisLikeClient()
    const store = createRedisAgentCoreToolSessionEventStore(client, { keyPrefix: 'test:' })

    const result = await run(function* () {
      const first = yield* store.appendRemoteEvent('session-1', 1, 'session-1:1', { type: 'progress', message: 'one' })
      const duplicate = yield* store.appendRemoteEvent('session-1', 1, 'session-1:1', { type: 'progress', message: 'one' })
      const sameSeqDifferentId = yield* store.appendRemoteEvent('session-1', 1, 'different', { type: 'progress', message: 'one' })
      const all = yield* store.readAfter('session-1', 0)
      return { first, duplicate, sameSeqDifferentId, all }
    })

    expect(result.first).toBe(1)
    expect(result.duplicate).toBe(1)
    expect(result.sameSeqDifferentId).toBe(2)
    expect(result.all.events).toHaveLength(2)

    const changedPayload = await run(function* () {
      return yield* store.appendRemoteEvent('session-1', 1, 'different', { type: 'progress', message: 'changed' })
    })
    expect(changedPayload).toBe(3)
  })
})
