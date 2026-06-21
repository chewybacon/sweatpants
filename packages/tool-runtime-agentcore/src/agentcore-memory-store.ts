import { createSignal, sleep, type Operation, type Signal } from 'effection'
import type {
  AgentCoreToolEvent,
  AgentCoreToolSessionHandle,
  SerializableToolSessionHandleStore,
  StoredToolSessionEvent,
  ToolSessionEventStore,
} from './agentcore-types.ts'

function isExpired(handle: AgentCoreToolSessionHandle): boolean {
  return Date.parse(handle.expiresAt) <= Date.now()
}

function cloneHandle(handle: AgentCoreToolSessionHandle): AgentCoreToolSessionHandle {
  return JSON.parse(JSON.stringify(handle)) as AgentCoreToolSessionHandle
}

export function createInMemoryAgentCoreToolSessionHandleStore(): SerializableToolSessionHandleStore<AgentCoreToolSessionHandle> & {
  entries(): AgentCoreToolSessionHandle[]
} {
  const handles = new Map<string, AgentCoreToolSessionHandle>()
  const callIndex = new Map<string, string>()
  const conversationIndex = new Map<string, Set<string>>()

  function dropIndexes(handle: AgentCoreToolSessionHandle): void {
    if (handle.callId) callIndex.delete(handle.callId)
    if (handle.conversationId) {
      const set = conversationIndex.get(handle.conversationId)
      set?.delete(handle.sessionId)
      if (set?.size === 0) conversationIndex.delete(handle.conversationId)
    }
  }

  function addIndexes(handle: AgentCoreToolSessionHandle): void {
    if (handle.callId) callIndex.set(handle.callId, handle.sessionId)
    if (handle.conversationId) {
      let set = conversationIndex.get(handle.conversationId)
      if (!set) {
        set = new Set<string>()
        conversationIndex.set(handle.conversationId, set)
      }
      set.add(handle.sessionId)
    }
  }

  function getLive(sessionId: string): AgentCoreToolSessionHandle | null {
    const handle = handles.get(sessionId)
    if (!handle) return null
    if (isExpired(handle)) {
      dropIndexes(handle)
      handles.delete(sessionId)
      return null
    }
    return handle
  }

  return {
    *create(handle: AgentCoreToolSessionHandle): Operation<void> {
      if (handles.has(handle.sessionId)) {
        throw new Error(`AgentCore tool session already exists: ${handle.sessionId}`)
      }
      const cloned = cloneHandle(handle)
      handles.set(cloned.sessionId, cloned)
      addIndexes(cloned)
    },

    *get(sessionId: string): Operation<AgentCoreToolSessionHandle | null> {
      const handle = getLive(sessionId)
      return handle ? cloneHandle(handle) : null
    },

    *update(sessionId: string, patch: Partial<AgentCoreToolSessionHandle>): Operation<AgentCoreToolSessionHandle> {
      const existing = getLive(sessionId)
      if (!existing) throw new Error(`AgentCore tool session not found: ${sessionId}`)
      dropIndexes(existing)
      const updated: AgentCoreToolSessionHandle = {
        ...existing,
        ...patch,
        sessionId: existing.sessionId,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      }
      handles.set(sessionId, updated)
      addIndexes(updated)
      return cloneHandle(updated)
    },

    *delete(sessionId: string): Operation<void> {
      const existing = handles.get(sessionId)
      if (existing) dropIndexes(existing)
      handles.delete(sessionId)
    },

    *findByCallId(callId: string): Operation<AgentCoreToolSessionHandle | null> {
      const sessionId = callIndex.get(callId)
      if (!sessionId) return null
      const handle = getLive(sessionId)
      return handle ? cloneHandle(handle) : null
    },

    *listByConversation(conversationId: string): Operation<AgentCoreToolSessionHandle[]> {
      const ids = conversationIndex.get(conversationId) ?? new Set<string>()
      const result: AgentCoreToolSessionHandle[] = []
      for (const id of ids) {
        const handle = getLive(id)
        if (handle) result.push(cloneHandle(handle))
      }
      return result
    },

    entries(): AgentCoreToolSessionHandle[] {
      return Array.from(handles.values()).map(cloneHandle)
    },
  }
}

export function createInMemoryAgentCoreToolSessionEventStore(): ToolSessionEventStore<AgentCoreToolEvent> & {
  entries(sessionId: string): StoredToolSessionEvent[]
} {
  const events = new Map<string, StoredToolSessionEvent[]>()
  const terminal = new Set<string>()
  const signals = new Map<string, Signal<void, void>>()
  const remoteDedup = new Map<string, StoredToolSessionEvent>()

  function getSignal(sessionId: string): Signal<void, void> {
    let signal = signals.get(sessionId)
    if (!signal) {
      signal = createSignal<void, void>()
      signals.set(sessionId, signal)
    }
    return signal
  }

  function list(sessionId: string): StoredToolSessionEvent[] {
    let current = events.get(sessionId)
    if (!current) {
      current = []
      events.set(sessionId, current)
    }
    return current
  }

  function isTerminalEvent(event: AgentCoreToolEvent): boolean {
    return event.type === 'result' || event.type === 'error' || event.type === 'cancelled'
  }

  return {
    *append(sessionId: string, event: AgentCoreToolEvent): Operation<number> {
      const current = list(sessionId)
      const lsn = current.length + 1
      current.push({
        sessionId,
        lsn,
        runtimeEventSeq: 0,
        runtimeEventId: `local:${sessionId}:${lsn}`,
        timestamp: new Date().toISOString(),
        event,
      })
      if (isTerminalEvent(event)) terminal.add(sessionId)
      getSignal(sessionId).send()
      return lsn
    },

    *appendRemoteEvent(sessionId: string, runtimeEventSeq: number, runtimeEventId: string, event: AgentCoreToolEvent): Operation<number> {
      const key = `${sessionId}:${runtimeEventSeq}:${runtimeEventId}`
      const existing = remoteDedup.get(key)
      if (existing) {
        const same = existing.runtimeEventId === runtimeEventId && JSON.stringify(existing.event) === JSON.stringify(event)
        if (same) return existing.lsn
        // Some AgentCore/runtime replay paths can resend the same runtime event
        // id with a changed payload during coroutine resume. Preserve forward
        // progress by appending the changed event locally instead of failing the
        // whole UI stream.
      }

      const current = list(sessionId)
      const lsn = current.length + 1
      const row: StoredToolSessionEvent = {
        sessionId,
        lsn,
        runtimeEventSeq,
        runtimeEventId,
        timestamp: new Date().toISOString(),
        event,
      }
      current.push(row)
      remoteDedup.set(key, row)
      if (isTerminalEvent(event)) terminal.add(sessionId)
      getSignal(sessionId).send()
      return lsn
    },

    *readAfter(sessionId: string, afterLSN = 0): Operation<{ events: Array<{ lsn: number; event: AgentCoreToolEvent }>; lastLSN: number }> {
      const current = list(sessionId)
      return {
        events: current.filter((row) => row.lsn > afterLSN).map((row) => ({ lsn: row.lsn, event: row.event })),
        lastLSN: current.length,
      }
    },

    *waitForChange(sessionId: string, afterLSN: number, timeoutMs?: number): Operation<void> {
      const started = Date.now()
      while (true) {
        const current = list(sessionId)
        if (current.length > afterLSN || terminal.has(sessionId)) return
        if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) return
        yield* sleep(10)
      }
    },

    *markTerminal(sessionId: string): Operation<void> {
      terminal.add(sessionId)
      getSignal(sessionId).send()
    },

    *isTerminal(sessionId: string): Operation<boolean> {
      return terminal.has(sessionId)
    },

    entries(sessionId: string): StoredToolSessionEvent[] {
      return [...list(sessionId)]
    },
  }
}
