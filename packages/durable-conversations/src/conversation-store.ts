import {
  createInMemoryBuffer,
  toOffsetString,
  type TokenBuffer,
} from '@sweatpants/durable-streams'
import type { Operation } from 'effection'

import type {
  ConversationEvent,
  ElicitResponseInput,
} from './event-types.ts'

interface PendingToolRequest {
  callId: string
  elicitId: string
  toolName: string
  args: Record<string, unknown>
}

export interface StoredConversation {
  id: string
  buffer: TokenBuffer<ConversationEvent>
  createdAt: number
  pendingTools: Map<string, PendingToolRequest>
}

export interface ConversationStore {
  create(id: string): Operation<{ created: boolean; conversation: StoredConversation }>
  get(id: string): StoredConversation | null
  appendEvent(
    id: string,
    event: Omit<ConversationEvent, 'id' | 'timestamp'>,
  ): Operation<ConversationEvent>
  read(id: string, offset: number): Operation<ConversationEvent[]>
  nextOffset(id: string): Operation<number>
  nextOffsetString(id: string): Operation<string>
  registerPendingTool(id: string, pending: PendingToolRequest): void
  resolvePendingTool(id: string, response: ElicitResponseInput): PendingToolRequest | null
}

export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, StoredConversation>()

  const ensure = (id: string): StoredConversation => {
    const existing = conversations.get(id)
    if (existing) {
      return existing
    }
    const created: StoredConversation = {
      id,
      buffer: createInMemoryBuffer<ConversationEvent>(id),
      createdAt: Date.now(),
      pendingTools: new Map(),
    }
    conversations.set(id, created)
    return created
  }

  return {
    *create(id) {
      const existing = conversations.get(id)
      if (existing) {
        return { created: false, conversation: existing }
      }
      const conversation = ensure(id)
      return { created: true, conversation }
    },

    get(id) {
      return conversations.get(id) ?? null
    },

    *appendEvent(id, event) {
      const conversation = ensure(id)
      const { lsn } = yield* conversation.buffer.read(Number.MAX_SAFE_INTEGER)
      const next = {
        ...event,
        id: `${id}:${lsn + 1}`,
        timestamp: Date.now(),
      }
      yield* conversation.buffer.append([next])
      return next
    },

    *read(id, offset) {
      const conversation = conversations.get(id)
      if (!conversation) {
        return []
      }
      const { tokens } = yield* conversation.buffer.read(offset)
      return tokens
    },

    *nextOffset(id) {
      const conversation = conversations.get(id)
      if (!conversation) {
        return 0
      }
      const { lsn } = yield* conversation.buffer.read(Number.MAX_SAFE_INTEGER)
      return lsn
    },

    *nextOffsetString(id) {
      const lsn = yield* this.nextOffset(id)
      return toOffsetString(lsn)
    },

    registerPendingTool(id, pending) {
      const conversation = ensure(id)
      conversation.pendingTools.set(pending.callId, pending)
    },

    resolvePendingTool(id, response) {
      const conversation = conversations.get(id)
      if (!conversation) {
        return null
      }
      const pending = conversation.pendingTools.get(response.callId)
      if (!pending || pending.elicitId !== response.elicitId) {
        return null
      }
      conversation.pendingTools.delete(response.callId)
      return pending
    },
  }
}
