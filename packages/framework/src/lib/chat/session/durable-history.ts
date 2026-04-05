import type { Operation } from 'effection'
import { call } from 'effection'
import type {
  ChatPatch,
  PendingHandoffState,
} from '../patches/index.ts'
import type { HydratedToolExecutionTrace, ToolExecutionTrace } from '../isomorphic-tools/runtime/emissions.ts'
import type { AnyIsomorphicTool } from '../isomorphic-tools/types.ts'
import type { Message } from '../types.ts'
import type { StreamEvent } from './streaming.ts'

interface DurableFrame {
  lsn: number
  event: StreamEvent
}

interface ReadDurableHistoryOptions {
  baseUrl: string
  conversationId: string
  tools?: AnyIsomorphicTool[]
}

export interface DurableHistoryReplay {
  patches: ChatPatch[]
  history: Message[]
}

function toolResultContent(content: string): string {
  return content.startsWith('Error:') ? content : content
}

function upsertPendingHandoff(
  pendingHandoffs: PendingHandoffState[],
  handoff: PendingHandoffState,
): PendingHandoffState[] {
  const next = pendingHandoffs.filter((item) => item.callId !== handoff.callId)
  next.push(handoff)
  return next
}

function* replayToolTrace(
  tools: AnyIsomorphicTool[] | undefined,
  toolName: string,
  trace: ToolExecutionTrace | undefined,
): Operation<HydratedToolExecutionTrace | null> {
  if (!trace || !tools?.length) {
    return null
  }

  const tool = tools.find((candidate) => candidate.name === toolName)
  if (!tool?.replayTrace) {
    return null
  }

  return yield* tool.replayTrace(trace)
}

export function* replayFramesToConversation(
  frames: DurableFrame[],
  tools?: AnyIsomorphicTool[],
): Operation<DurableHistoryReplay> {
  const patches: ChatPatch[] = []
  const history: Message[] = []
  let currentAssistantText = ''
  let pendingToolCalls: Array<{ id: string; name: string; arguments: unknown }> = []
  let pendingHandoffs: PendingHandoffState[] = []
  let seededFromConversationState = false

  for (const frame of frames) {
    const event = frame.event

    switch (event.type) {
      case 'session_info': {
        patches.push({
          type: 'session_info',
          capabilities: event.capabilities,
          persona: event.persona,
        })
        break
      }

      case 'text': {
        currentAssistantText += event.content
        break
      }

      case 'thinking': {
        break
      }

      case 'tool_calls': {
        pendingToolCalls = event.calls
        break
      }

      case 'tool_result': {
        const replayedTrace = yield* replayToolTrace(
          tools,
          event.name,
          event.trace,
        )

        const toolMessage: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          tool_call_id: event.id,
          content: toolResultContent(event.content),
        }

        history.push(toolMessage)
        patches.push({
          type: 'history_message',
          message: toolMessage,
        })
        if (replayedTrace) {
          patches.push({
            type: 'tool_emission_start',
            callId: event.id,
            toolName: event.name,
          })
          for (const entry of replayedTrace.emissions) {
            patches.push({
              type: 'tool_emission',
              callId: event.id,
              toolName: event.name,
              emission: {
                id: `${event.id}-replay-${entry.order + 1}`,
                type: '__component__',
                payload: {
                  componentKey: entry.componentKey,
                  props: entry.props,
                  ...(entry._component && { _component: entry._component }),
                },
                status: 'complete',
                timestamp: entry.timestamp,
                ...(entry.response !== undefined ? { response: entry.response } : {}),
              },
            })
          }
          patches.push({
            type: 'tool_emission_complete',
            callId: event.id,
            trace: replayedTrace,
          })
        }
        break
      }

      case 'tool_error': {
        const toolErrorMessage: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          tool_call_id: event.id,
          content: `Error: ${event.message}`,
        }

        history.push(toolErrorMessage)
        patches.push({
          type: 'history_message',
          message: toolErrorMessage,
        })
        break
      }

      case 'complete': {
        const assistantText = currentAssistantText || event.text

        if (pendingToolCalls.length > 0) {
          const assistantWithTools: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assistantText,
            tool_calls: pendingToolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.arguments as Record<string, unknown>,
              },
            })),
          }

          history.push(assistantWithTools)
          patches.push({
            type: 'history_message',
            message: assistantWithTools,
          })
        } else if (assistantText) {
          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assistantText,
          }

          history.push(assistantMessage)
          patches.push({
            type: 'history_message',
            message: assistantMessage,
          })
        }

        currentAssistantText = ''
        pendingToolCalls = []
        pendingHandoffs = []
        break
      }

      case 'error': {
        patches.push({
          type: 'error',
          message: event.message,
        })
        break
      }

      case 'conversation_state': {
        if (!seededFromConversationState && history.length === 0 && event.conversationState.messages.length > 0) {
          for (const message of event.conversationState.messages) {
            history.push(message)
            patches.push({
              type: 'history_message',
              message,
            })
          }
          seededFromConversationState = true
        }

        currentAssistantText = event.conversationState.assistantContent
        pendingToolCalls = event.conversationState.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }))
        break
      }

      case 'isomorphic_handoff': {
        pendingHandoffs = upsertPendingHandoff(pendingHandoffs, {
          callId: event.callId,
          toolName: event.toolName,
          params: event.params,
          data: event.serverOutput,
          usesHandoff: event.usesHandoff ?? false,
        })

        patches.push({
          type: 'pending_handoff',
          handoff: {
            callId: event.callId,
            toolName: event.toolName,
            params: event.params,
            data: event.serverOutput,
            usesHandoff: event.usesHandoff ?? false,
          },
        })
        break
      }

      case 'elicit_request': {
        if (!patches.some((patch) => patch.type === 'elicit_start' && patch.callId === event.callId)) {
          patches.push({
            type: 'elicit_start',
            callId: event.callId,
            toolName: event.toolName,
          })
        }

        patches.push({
          type: 'elicit',
          callId: event.callId,
          elicit: {
            elicitId: event.elicitId,
            sessionId: event.sessionId,
            key: event.key,
            message: event.message,
            schema: event.schema,
            context: (event.schema as { 'x-model-context'?: unknown })['x-model-context'],
            status: 'pending',
            timestamp: Date.now(),
          },
        })
        break
      }

      case 'tool_session_status':
      case 'tool_session_error': {
        break
      }
    }
  }

  return { patches, history }
}

export function* readDurableHistory(
  options: ReadDurableHistoryOptions,
): Operation<DurableHistoryReplay> {
  const { baseUrl, conversationId, tools } = options
  const url = new URL(baseUrl, 'http://localhost')
  url.searchParams.set('conversationId', conversationId)

  const response = yield* call(() =>
    fetch(url.pathname + url.search, {
      method: 'GET',
      headers: {
        Accept: 'application/x-ndjson',
      },
    }),
  )

  if (response.status === 404) {
    return { patches: [], history: [] }
  }

  if (!response.ok) {
    throw new Error(`Failed to hydrate durable history: ${response.status}`)
  }

  const text = yield* call(() => response.text())
  const trimmed = text.trim()

  if (!trimmed) {
    return { patches: [], history: [] }
  }

  const frames = trimmed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DurableFrame)

  return yield* replayFramesToConversation(frames, tools)
}
