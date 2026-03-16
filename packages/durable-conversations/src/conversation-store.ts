import { toOffsetString } from '@sweatpants/durable-streams'

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
  events: ConversationEvent[]
  createdAt: number
  pendingTools: Map<string, PendingToolRequest>
}

export interface ConversationStore {
  create(id: string): { created: boolean; conversation: StoredConversation }
  get(id: string): StoredConversation | null
  appendEvent(id: string, event: Omit<ConversationEvent, 'id' | 'timestamp'>): ConversationEvent
  read(id: string, offset: number): ConversationEvent[]
  nextOffset(id: string): number
  nextOffsetString(id: string): string
  registerPendingTool(id: string, pending: PendingToolRequest): void
  resolvePendingTool(id: string, response: ElicitResponseInput): PendingToolRequest | null
}

function createEventId(conversationId: string, index: number): string {
  return `${conversationId}:${index + 1}`
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
      events: [],
      createdAt: Date.now(),
      pendingTools: new Map(),
    }
    conversations.set(id, created)
    return created
  }

  return {
    create(id) {
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

    appendEvent(id, event) {
      const conversation = ensure(id)
      const next = {
        ...event,
        id: createEventId(id, conversation.events.length),
        timestamp: Date.now(),
      }
      conversation.events.push(next)
      return next
    },

    read(id, offset) {
      const conversation = conversations.get(id)
      if (!conversation) {
        return []
      }
      return conversation.events.slice(offset)
    },

    nextOffset(id) {
      const conversation = conversations.get(id)
      return conversation ? conversation.events.length : 0
    },

    nextOffsetString(id) {
      return toOffsetString(this.nextOffset(id))
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
