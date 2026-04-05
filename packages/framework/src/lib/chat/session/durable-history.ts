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
import type { PatchTransform } from './options.ts'
import { renderReplayMessageParts } from './replay-render.ts'

interface DurableFrame {
  lsn: number
  event: StreamEvent
}

interface ReadDurableHistoryOptions {
  baseUrl: string
  conversationId: string
  tools?: AnyIsomorphicTool[]
  transforms?: PatchTransform[]
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
  transforms?: PatchTransform[],
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

          const parts = yield* renderReplayMessageParts(assistantText, transforms)

          history.push(assistantWithTools)
          patches.push({
            type: 'history_message',
            message: assistantWithTools,
            ...(parts ? { parts } : {}),
          })
        } else if (assistantText) {
          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assistantText,
          }

          const parts = yield* renderReplayMessageParts(assistantText, transforms)

          history.push(assistantMessage)
          patches.push({
            type: 'history_message',
            message: assistantMessage,
            ...(parts ? { parts } : {}),
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
          const replayToolTraceByCallId = new Map(
            (event.conversationState.replay?.toolTraces ?? []).map((trace) => [trace.callId, trace]),
          )

          for (const message of event.conversationState.messages) {
            if (history.some((existing) => existing.id === message.id)) {
              continue
            }

            const toolResults = event.conversationState.messages.filter(
              (candidate) => candidate.role === 'tool',
            )
            const parts = message.role === 'assistant'
              ? yield* renderReplayMessageParts(message.content, transforms)
              : undefined
            let assistantParts = parts ?? []

            if (message.role === 'assistant' && message.tool_calls?.length) {
              for (const toolCall of message.tool_calls) {
                const toolResult = toolResults.find((candidate) => candidate.tool_call_id === toolCall.id)
                const error = toolResult?.content?.startsWith('Error:') ? toolResult.content : undefined
                const replayedTrace = replayToolTraceByCallId.get(toolCall.id)
                const hydratedTrace = replayedTrace
                  ? yield* replayToolTrace(tools, replayedTrace.toolName, replayedTrace.trace)
                  : null
                const emissions = hydratedTrace?.emissions
                  .map((entry) => ({
                    id: `${toolCall.id}-replay-${entry.order + 1}`,
                    status: 'complete' as const,
                    component: entry._component,
                    props: entry.props,
                    ...(entry.response !== undefined ? { response: entry.response } : {}),
                  }))
                  .filter((emission) => emission.component)
                  .map((emission) => ({
                    id: emission.id,
                    status: emission.status,
                    component: emission.component!,
                    props: emission.props,
                    ...(emission.response !== undefined ? { response: emission.response } : {}),
                  })) ?? []

                assistantParts = [
                  ...assistantParts,
                  {
                    id: `${message.id}-tool-${toolCall.id}`,
                    type: 'tool-call' as const,
                    callId: toolCall.id,
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                    state: toolResult ? (error ? 'error' as const : 'complete' as const) : 'running' as const,
                    ...(toolResult && !error ? { result: toolResult.content } : {}),
                    ...(error ? { error } : {}),
                    emissions,
                    pluginElicits: [],
                  },
                ]
              }
            }

            history.push(message)
            patches.push({
              type: 'history_message',
              message,
              ...(message.role === 'assistant' && assistantParts.length > 0 ? { parts: assistantParts } : {}),
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
  const { baseUrl, conversationId, tools, transforms } = options
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

  return yield* replayFramesToConversation(frames, tools, transforms)
}
