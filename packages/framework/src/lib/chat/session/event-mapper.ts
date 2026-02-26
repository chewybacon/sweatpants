/**
 * lib/chat/session/event-mapper.ts
 */
import type { Operation, Channel, Stream } from 'effection'
import { each } from 'effection'
import type { ChatPatch } from '../patches/index.ts'
import type {
  StreamEvent,
  StreamResult,
  IsomorphicHandoffStreamEvent,
  ElicitRequestStreamEvent,
} from './streaming.ts'

export function* mapStreamEventsToPatches(
  eventStream: Stream<unknown, void>,
  patches: Channel<ChatPatch, void>
): Operation<StreamResult> {
  let assistantText = ''
  const isomorphicHandoffs: IsomorphicHandoffStreamEvent[] = []
  const elicitRequests: ElicitRequestStreamEvent[] = []
  const emissionStartedForCall = new Set<string>()
  let conversationState: any | null = null
  const toolResults: Array<{ id: string; name: string; content: string }> = []
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = []

  for (const rawEvent of yield* each(eventStream)) {
    const event = (rawEvent as { lsn: number; event: StreamEvent }).event

    switch (event.type) {
      case 'session_info':
        yield* patches.send({
          type: 'session_info',
          capabilities: event.capabilities,
          persona: event.persona,
        })
        break

      case 'text':
        assistantText += event.content
        yield* patches.send({ type: 'streaming_text', content: event.content })
        break

      case 'thinking':
        yield* patches.send({
          type: 'streaming_reasoning',
          content: event.content,
        })
        break

      case 'tool_calls':
        for (const call of event.calls) {
          toolCalls.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
          yield* patches.send({
            type: 'tool_call_start',
            call: {
              id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })
        }
        break

      case 'tool_result':
        toolResults.push({
          id: event.id,
          name: event.name,
          content: event.content,
        })
        yield* patches.send({
          type: 'tool_call_result',
          id: event.id,
          result: event.content,
        })
        break

      case 'tool_error':
        yield* patches.send({
          type: 'tool_call_error',
          id: event.id,
          error: event.message,
        })
        break

      case 'complete':
        assistantText = event.text
        break

      case 'isomorphic_handoff':
        isomorphicHandoffs.push(event)
        yield* patches.send({
          type: 'isomorphic_tool_state',
          id: event.callId,
          state: 'awaiting_client_approval',
          serverOutput: event.serverOutput,
        })
        break

      case 'conversation_state':
        conversationState = event.conversationState
        break

      case 'error':
        yield* patches.send({ type: 'error', message: event.message })
        if (!event.recoverable) {
          throw new Error(event.message)
        }
        break

      case 'elicit_request':
        elicitRequests.push(event)

        if (!emissionStartedForCall.has(event.callId)) {
          emissionStartedForCall.add(event.callId)
          yield* patches.send({
            type: 'elicit_start',
            callId: event.callId,
            toolName: event.toolName,
          })
        }

        yield* patches.send({
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

      case 'tool_session_status':
        break

      case 'tool_session_error':
        yield* patches.send({ type: 'error', message: event.message })
        break
    }

    yield* each.next()
  }

  if (elicitRequests.length > 0) {
    const state = conversationState ?? {
      messages: [],
      assistantContent: assistantText,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments as Record<string, unknown>,
      })),
      serverToolResults: [],
    }

    return {
      type: 'elicit',
      pendingElicitations: elicitRequests,
      conversationState: state,
    }
  }

  if (isomorphicHandoffs.length > 0) {
    const state = conversationState ?? {
      messages: [],
      assistantContent: assistantText,
      toolCalls: [],
      serverToolResults: [],
    }

    return {
      type: 'isomorphic_handoff',
      handoffs: isomorphicHandoffs,
      conversationState: state,
    }
  }

  return {
    type: 'complete',
    text: assistantText,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  }
}
