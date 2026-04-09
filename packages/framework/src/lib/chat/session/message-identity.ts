import type { Message, ToolCall } from '../types.ts'

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function deriveTurnKeyFromToolCalls(toolCallIds: string[]): string {
  const sorted = sortedUnique(toolCallIds)
  if (sorted.length === 0) {
    throw new Error('Cannot derive turn key without tool call ids')
  }
  return sorted[0]!
}

export function turnKeyFromToolCalls(toolCalls: Array<{ id: string }> | ToolCall[]): string {
  return deriveTurnKeyFromToolCalls(toolCalls.map((toolCall) => toolCall.id))
}

export function messageIdForUser(turnKey: string): string {
  return `user:${turnKey}`
}

export function messageIdForAssistantTools(toolCallIds: string[]): string {
  const sorted = sortedUnique(toolCallIds)
  if (sorted.length === 0) {
    throw new Error('Cannot create assistant tools id without tool call ids')
  }
  return `assistant:tools:${sorted.join(',')}`
}

export function messageIdForTool(toolCallId: string): string {
  if (!toolCallId) {
    throw new Error('Cannot create tool message id without tool_call_id')
  }
  return `tool:${toolCallId}`
}

export function messageIdForAssistantFinal(turnKey: string): string {
  return `assistant:final:${turnKey}`
}

export function messageIdForSystem(index: number): string {
  return `system:${index}`
}

export function assertMessageHasId(message: Message, context: string): string {
  if (!message.id) {
    throw new Error(`Expected message id for ${context}`)
  }
  return message.id
}

export function inferTurnKeyFromHistory(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.role === 'tool' && message.tool_call_id) {
      return message.tool_call_id
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      return turnKeyFromToolCalls(message.tool_calls)
    }
    if (message.role === 'user' && message.id?.startsWith('user:')) {
      return message.id.slice('user:'.length)
    }
  }

  const userCount = history.filter((message) => message.role === 'user').length
  return `u${Math.max(1, userCount)}`
}

export function nextUserTurnKey(history: Message[]): string {
  const userCount = history.filter((message) => message.role === 'user').length
  return `u${userCount + 1}`
}

export function normalizeTranscriptMessageIds(messages: Message[]): Message[] {
  const normalized: Message[] = []
  let systemCount = 0
  let userCount = 0
  let currentTurnKey = 'u1'

  for (const message of messages) {
    if (message.id) {
      normalized.push(message)
      if (message.role === 'user' && message.id.startsWith('user:')) {
        currentTurnKey = message.id.slice('user:'.length)
        userCount += 1
      } else if (message.role === 'system') {
        systemCount += 1
      }
      continue
    }

    if (message.role === 'system') {
      normalized.push({ ...message, id: messageIdForSystem(systemCount++) })
      continue
    }

    if (message.role === 'user') {
      userCount += 1
      currentTurnKey = `u${userCount}`
      normalized.push({ ...message, id: messageIdForUser(currentTurnKey) })
      continue
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      currentTurnKey = turnKeyFromToolCalls(message.tool_calls)
      normalized.push({
        ...message,
        id: messageIdForAssistantTools(message.tool_calls.map((toolCall) => toolCall.id)),
      })
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      currentTurnKey = message.tool_call_id
      normalized.push({ ...message, id: messageIdForTool(message.tool_call_id) })
      continue
    }

    if (message.role === 'assistant') {
      normalized.push({ ...message, id: messageIdForAssistantFinal(currentTurnKey) })
      continue
    }

    normalized.push(message)
  }

  return normalized
}
