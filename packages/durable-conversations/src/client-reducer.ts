import type { ConversationEvent } from './event-types.ts'

export interface ReducedAssistantMessage {
  id: string
  text: string
  completed: boolean
}

export interface ReducedConversationState {
  assistantMessages: Record<string, ReducedAssistantMessage>
  orderedAssistantMessageIds: string[]
}

export function createReducedConversationState(): ReducedConversationState {
  return {
    assistantMessages: {},
    orderedAssistantMessageIds: [],
  }
}

export function applyConversationEvent(
  state: ReducedConversationState,
  event: ConversationEvent,
): ReducedConversationState {
  if (event.type !== 'assistant_message_delta' && event.type !== 'assistant_message_complete') {
    return state
  }

  const messageId = event.messageId ?? event.id
  const existing = state.assistantMessages[messageId] ?? {
    id: messageId,
    text: '',
    completed: false,
  }

  const next =
    event.type === 'assistant_message_delta'
      ? {
          ...existing,
          text: `${existing.text}${event.content}`,
        }
      : {
          ...existing,
          text: event.content,
          completed: true,
        }

  return {
    assistantMessages: {
      ...state.assistantMessages,
      [messageId]: next,
    },
    orderedAssistantMessageIds: state.orderedAssistantMessageIds.includes(messageId)
      ? state.orderedAssistantMessageIds
      : [...state.orderedAssistantMessageIds, messageId],
  }
}

export function reduceConversationEvents(events: ConversationEvent[]): ReducedConversationState {
  return events.reduce(applyConversationEvent, createReducedConversationState())
}
