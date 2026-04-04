export type ThreadActor = 'user' | 'assistant'

export type ThreadEventType =
  | 'user_message'
  | 'assistant_message_delta'
  | 'assistant_message_complete'

export interface ThreadEvent {
  id: string
  from: ThreadActor
  type: ThreadEventType
  content: string
  timestamp: number
  messageId?: string
}

export interface ThreadFrame {
  offset: string
  event: ThreadEvent
}

export interface ThreadMessageInput {
  role: 'user'
  content: string
}

export interface ThreadSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  lastMessagePreview: string
  messageCount: number
}

export interface ThreadViewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function summarizeThreadFromEvents(
  threadId: string,
  events: ThreadEvent[],
  fallbackCreatedAt: number = Date.now(),
): ThreadSummary {
  const userMessages = events.filter((event) => event.type === 'user_message')
  const visibleMessages = events.filter(
    (event) => event.type === 'user_message' || event.type === 'assistant_message_complete',
  )
  const titleSource = userMessages[0]?.content ?? 'New thread'
  const lastSource = visibleMessages[visibleMessages.length - 1]?.content ?? 'No messages yet'
  const createdAt = events[0]?.timestamp ?? fallbackCreatedAt
  const updatedAt = events[events.length - 1]?.timestamp ?? fallbackCreatedAt
  const title = compact(titleSource) || 'New thread'
  const preview = compact(lastSource) || 'No messages yet'

  return {
    id: threadId,
    title: title.length > 40 ? `${title.slice(0, 37)}...` : title,
    createdAt,
    updatedAt,
    lastMessagePreview: preview.length > 80 ? `${preview.slice(0, 77)}...` : preview,
    messageCount: visibleMessages.length,
  }
}

export function deriveThreadMessages(events: ThreadEvent[]): ThreadViewMessage[] {
  const messages: ThreadViewMessage[] = []
  const assistantIndexes = new Map<string, number>()

  for (const event of events) {
    if (event.type === 'user_message') {
      messages.push({
        id: event.id,
        role: 'user',
        content: event.content,
        isStreaming: false,
      })
      continue
    }

    if (event.type === 'assistant_message_delta') {
      const messageId = event.messageId ?? event.id
      const existingIndex = assistantIndexes.get(messageId)
      if (existingIndex === undefined) {
        assistantIndexes.set(messageId, messages.length)
        messages.push({
          id: messageId,
          role: 'assistant',
          content: event.content,
          isStreaming: true,
        })
      } else {
        const existing = messages[existingIndex]
        if (existing) {
          existing.content += event.content
          existing.isStreaming = true
        }
      }
      continue
    }

    if (event.type === 'assistant_message_complete') {
      const messageId = event.messageId ?? event.id
      const existingIndex = assistantIndexes.get(messageId)
      if (existingIndex === undefined) {
        assistantIndexes.set(messageId, messages.length)
        messages.push({
          id: messageId,
          role: 'assistant',
          content: event.content,
          isStreaming: false,
        })
      } else {
        const existing = messages[existingIndex]
        if (existing) {
          existing.content = event.content
          existing.isStreaming = false
        }
      }
    }
  }

  return messages
}
