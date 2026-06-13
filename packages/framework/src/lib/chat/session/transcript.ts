import type { Message, ToolCall } from '../types.ts'
import {
  deriveTurnKeyFromToolCalls,
  messageIdForAssistantFinal,
  messageIdForAssistantTools,
  messageIdForSystem,
  messageIdForTool,
  messageIdForUser,
} from './message-identity.ts'

export interface TranscriptState {
  systemCount: number
  userCount: number
  currentTurnKey: string
}

export function createTranscriptState(messages: Message[] = []): TranscriptState {
  const state: TranscriptState = {
    systemCount: 0,
    userCount: 0,
    currentTurnKey: 'u1',
  }

  resetTranscriptState(state, messages)
  return state
}

export function resetTranscriptState(state: TranscriptState, messages: Message[] = []): TranscriptState {
  state.systemCount = 0
  state.userCount = 0
  state.currentTurnKey = 'u1'

  for (const message of messages) {
    if (message.role === 'system') {
      state.systemCount += 1
      continue
    }

    if (message.role === 'user') {
      state.userCount += 1
      if (message.id?.startsWith('user:')) {
        state.currentTurnKey = message.id.slice('user:'.length)
      } else {
        state.currentTurnKey = `u${state.userCount}`
      }
      continue
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      state.currentTurnKey = deriveTurnKeyFromToolCalls(message.tool_calls.map((toolCall) => toolCall.id))
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      state.currentTurnKey = message.tool_call_id
    }
  }

  return state
}

export function appendSystemMessage(
  history: Message[],
  state: TranscriptState,
  content: string,
): Message {
  const message: Message = {
    id: messageIdForSystem(state.systemCount),
    role: 'system',
    content,
  }
  state.systemCount += 1
  history.push(message)
  return message
}

export function appendUserMessage(
  history: Message[],
  state: TranscriptState,
  content: string,
): Message {
  state.userCount += 1
  state.currentTurnKey = `u${state.userCount}`
  const message: Message = {
    id: messageIdForUser(state.currentTurnKey),
    role: 'user',
    content,
  }
  history.push(message)
  return message
}

export function appendAssistantToolCallMessage(
  history: Message[],
  state: TranscriptState,
  toolCalls: ToolCall[],
  content: string,
): Message {
  const toolCallIds = toolCalls.map((toolCall) => toolCall.id)
  state.currentTurnKey = deriveTurnKeyFromToolCalls(toolCallIds)
  const message: Message = {
    id: messageIdForAssistantTools(toolCallIds),
    role: 'assistant',
    content,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: toolCall.function,
    })),
  }
  history.push(message)
  return message
}

export function appendToolMessage(
  history: Message[],
  state: TranscriptState,
  toolCallId: string,
  content: string,
  replay?: Message['replay'],
): Message {
  state.currentTurnKey = toolCallId
  const message: Message = {
    id: messageIdForTool(toolCallId),
    role: 'tool',
    tool_call_id: toolCallId,
    content,
    ...(replay ? { replay } : {}),
  }
  history.push(message)
  return message
}

export function appendAssistantFinalMessage(
  history: Message[],
  state: TranscriptState,
  content: string,
): Message {
  const id = messageIdForAssistantFinal(state.currentTurnKey)
  const message: Message = {
    id,
    role: 'assistant',
    content,
  }

  const existingIndex = history.findIndex((entry) => entry.id === id)
  if (existingIndex >= 0) {
    history[existingIndex] = message
    return message
  }

  history.push(message)
  return message
}
