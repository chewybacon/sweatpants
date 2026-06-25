/**
 * AgentStream — the durable-stream-backed event+command log for one conversation.
 *
 * One stream per `contextId` (Spec REQ-007). Participants (human via useChat,
 * an agent harness, a bridged remote agent) subscribe to events and append
 * events/commands. The underlying store is `@sweatpants/durable-streams`
 * (LSN-ordered, append-only, resumable via read(afterLSN) + waitForChange).
 */

import { resource } from 'effection'
import type { Operation, Stream } from 'effection'

import {
  createInMemoryBufferStore,
} from '@sweatpants/durable-streams/in-memory-store'
import type { TokenBuffer } from '@sweatpants/durable-streams/types'

import type { AgentEvent } from './events.ts'
import type { AgentCommandEntry } from './commands.ts'
import type { AgentLogEntry } from './log.ts'
import { isAgentEvent, isCommand } from './log.ts'

export interface AgentStreamStore {
  /** Get or create the buffer for a contextId. */
  getOrCreate(contextId: string): Operation<TokenBuffer<AgentLogEntry>>
}

/**
 * In-memory AgentStream store backed by durable-streams' in-memory buffer
 * store, plus a `contextId -> latest checkpoint LSN` index (Spec REQ-013).
 */
export function createInMemoryAgentStreamStore(): AgentStreamStore & {
  checkpointIndex: Map<string, number>
} {
  const bufferStore = createInMemoryBufferStore<AgentLogEntry>()
  const buffers = new Map<string, TokenBuffer<AgentLogEntry>>()
  const checkpointIndex = new Map<string, number>()

  return {
    checkpointIndex,
    *getOrCreate(contextId) {
      let buffer = buffers.get(contextId)
      if (!buffer) {
        buffer = yield* bufferStore.create(contextId)
        buffers.set(contextId, buffer)
      }
      return buffer
    },
  }
}

export interface AgentStream {
  readonly contextId: string
  /** Append an event or command; lsn + timestamp are assigned here. */
  append(entry: Appendable): Operation<AgentEvent | AgentCommandEntry>
  /** Read raw log entries after an LSN. */
  readEntries(afterLSN?: number): Operation<{ entries: AgentLogEntry[]; lsn: number }>
  /** A resumable stream of events only (filters commands). */
  events(afterLSN?: number): Stream<AgentEvent, void>
  /** A resumable stream of commands only (filters events). */
  commands(afterLSN?: number): Stream<AgentCommandEntry, void>
  /** Record the latest checkpoint LSN for this contextId (REQ-013 index). */
  recordCheckpoint(lsn: number): void
  /** O(1) lookup of the latest checkpoint LSN (undefined if none). */
  latestCheckpointLsn(): number | undefined
  /** The raw buffer (for advanced callers). */
  readonly buffer: TokenBuffer<AgentLogEntry>
}

/** An event or command awaiting lsn/timestamp assignment. */
export type Appendable = (AgentEvent | AgentCommandEntry) & {
  lsn?: number
  timestamp?: number
}

export function createAgentStream(
  contextId: string,
  buffer: TokenBuffer<AgentLogEntry>,
  checkpointIndex?: Map<string, number>,
): AgentStream {
  function* appendEntry(
    entry: Appendable,
  ): Operation<AgentEvent | AgentCommandEntry> {
    ;(entry as { timestamp: number }).timestamp = Date.now()
    const newLen = yield* buffer.append([entry as AgentLogEntry])
    ;(entry as { lsn: number }).lsn = newLen - 1
    return entry as AgentEvent | AgentCommandEntry
  }

  function tail(
    afterLSN: number,
    filter: (e: AgentLogEntry) => boolean,
  ): Stream<AgentEvent | AgentCommandEntry, void> {
    return resource(function* (provide) {
      let cursor = afterLSN
      yield* provide({
        *next(): Operation<IteratorResult<AgentEvent | AgentCommandEntry, void>> {
          while (true) {
            const { entries } = yield* readEntriesInternal(cursor)
            if (entries.length > 0) {
              const next = entries[0]!
              cursor = (next.lsn ?? cursor) + 1
              if (filter(next)) {
                return { done: false, value: next }
              }
              continue
            }
            const complete = yield* buffer.isComplete()
            const error = yield* buffer.getError()
            if (error) throw error
            if (complete) return { done: true, value: undefined }
            yield* buffer.waitForChange(cursor)
          }
        },
      })
    })
  }

  function* readEntriesInternal(
    afterLSN: number,
  ): Operation<{ entries: AgentLogEntry[]; lsn: number }> {
    const { tokens, lsn } = yield* buffer.read(afterLSN)
    return { entries: tokens as AgentLogEntry[], lsn }
  }

  return {
    contextId,
    buffer,
    *append(entry) {
      return yield* appendEntry(entry)
    },
    *readEntries(afterLSN = 0) {
      return yield* readEntriesInternal(afterLSN)
    },
    events(afterLSN = 0) {
      return tail(afterLSN, isAgentEvent) as Stream<AgentEvent, void>
    },
    commands(afterLSN = 0) {
      return tail(afterLSN, isCommand) as Stream<AgentCommandEntry, void>
    },
    recordCheckpoint(lsn) {
      const prev = checkpointIndex?.get(contextId)
      if (prev === undefined || lsn > prev) {
        checkpointIndex?.set(contextId, lsn)
      }
    },
    latestCheckpointLsn() {
      return checkpointIndex?.get(contextId)
    },
  }
}
