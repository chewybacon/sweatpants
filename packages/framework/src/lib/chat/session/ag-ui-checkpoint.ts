import type { ToolCall } from '../types.ts'
import type {
  AgUiCheckpoint,
  AgUiCustomState,
  ConversationReplayState,
} from './streaming.ts'
import type { ServerToolResult } from '../core-types.ts'
import type { ElicitRequestStreamEvent, IsomorphicHandoffStreamEvent } from './streaming.ts'

export interface BuildAgUiCheckpointOptions {
  threadId: string
  runId: string
  parentRunId?: string
  messages: AgUiCheckpoint['messages']['messages']
  assistantContent: string
  toolCalls: ToolCall[]
  serverToolResults: ServerToolResult[]
  replay?: ConversationReplayState
}

export function buildAgUiCheckpoint(options: BuildAgUiCheckpointOptions): AgUiCheckpoint {
  const {
    threadId,
    runId,
    parentRunId,
    messages,
    assistantContent,
    toolCalls,
    serverToolResults,
    replay,
  } = options

  return {
    run: {
      threadId,
      runId,
      ...(parentRunId ? { parentRunId } : {}),
    },
    messages: {
      messages,
    },
    state: {
      assistantContent,
      toolCalls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
      serverToolResults,
      ...(replay ? { replay } : {}),
    },
  }
}

export function buildAgUiCustomState(options: {
  replay?: ConversationReplayState
  handoffs?: IsomorphicHandoffStreamEvent[]
  elicits?: ElicitRequestStreamEvent[]
}): AgUiCustomState {
  const pendingClientActions = [
    ...(options.handoffs ?? []).map((handoff) => ({
      toolCallId: handoff.callId,
      toolName: handoff.toolName,
      kind: 'handoff' as const,
      params: handoff.params,
      data: handoff.serverOutput,
      usesHandoff: handoff.usesHandoff ?? false,
    })),
    ...(options.elicits ?? []).map((elicit) => ({
      toolCallId: elicit.callId,
      toolName: elicit.toolName,
      kind: 'elicit' as const,
      sessionId: elicit.sessionId,
      elicitId: elicit.elicitId,
      key: elicit.key,
      message: elicit.message,
      schema: elicit.schema,
    })),
  ]

  return {
    ...(options.replay ? { replay: options.replay } : {}),
    ...(pendingClientActions.length > 0 ? { pendingClientActions } : {}),
  }
}
