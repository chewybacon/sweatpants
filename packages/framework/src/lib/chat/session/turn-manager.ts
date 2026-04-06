/**
 * lib/chat/session/turn-manager.ts
 *
 * Utilities for syncing conversation state and history across turns.
 */
import type { ConversationState } from './streaming.ts'
import type { Message } from '../types.ts'

export type PendingToolCall = { id: string; name: string }

export function syncConversationStateForElicit(
  history: Message[],
  conversationState: ConversationState
): PendingToolCall[] {
  const conversationMessages = conversationState.messages
  const originalHistoryLength = history.length

  for (let i = originalHistoryLength; i < conversationMessages.length; i++) {
    const convMsg = conversationMessages[i]!
    history.push({
      ...convMsg,
      id: convMsg.id ?? crypto.randomUUID(),
    })
  }

  const hasAssistantWithTools = conversationMessages.some(
    (msg) => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0
  )

  if (!hasAssistantWithTools && conversationState.toolCalls.length > 0) {
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: conversationState.assistantContent || '',
      tool_calls: conversationState.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    }
    history.push(assistantMsg)
  }

  return conversationState.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
  }))
}

export function syncConversationStateForComplete(
  history: Message[],
  conversationState: ConversationState,
): void {
  const seenIds = new Set(history.map((message) => message.id).filter(Boolean))

  for (const convMsg of conversationState.messages) {
    const id = convMsg.id ?? crypto.randomUUID()
    if (seenIds.has(id)) {
      continue
    }

    history.push({
      ...convMsg,
      id,
    })
    seenIds.add(id)
  }

  if (conversationState.assistantContent) {
    const lastAssistant = history[history.length - 1]
    if (!lastAssistant || lastAssistant.role !== 'assistant' || lastAssistant.content !== conversationState.assistantContent) {
      history.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: conversationState.assistantContent,
      })
    }
  }
}

export function syncMessagesFromIndex(
  history: Message[],
  sourceMessages: Message[],
  startIndex: number,
  toolResultsMap?: Map<string, string>
): void {
  for (let i = startIndex; i < sourceMessages.length; i++) {
    const apiMsg = sourceMessages[i]!
    let content = apiMsg.content

    if (apiMsg.role === 'tool' && apiMsg.tool_call_id && toolResultsMap) {
      const updatedContent = toolResultsMap.get(apiMsg.tool_call_id)
      if (updatedContent) {
        content = updatedContent
      }
    }

    const msg: Message = {
      id: crypto.randomUUID(),
      role: apiMsg.role,
      content: content,
    }

    if (apiMsg.tool_calls && apiMsg.tool_calls.length > 0) {
      msg.tool_calls = apiMsg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: tc.function,
      }))
    }

    if (apiMsg.tool_call_id) {
      msg.tool_call_id = apiMsg.tool_call_id
    }

    history.push(msg)
  }
}
