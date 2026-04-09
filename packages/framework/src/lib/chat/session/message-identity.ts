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
