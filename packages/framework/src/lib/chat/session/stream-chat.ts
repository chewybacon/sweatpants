/**
 * lib/chat/session/stream-chat.ts
 *
 * Effection operation for a single streaming chat request.
 * Bridges async generator → Effection stream, with proper cancellation.
 *
 * Responsibilities:
 * - Create abortable fetch using Effection's useAbortSignal
 * - Parse response body via parseNDJSON Effection stream
 * - Convert to Effection stream and consume with each()
 * - Emit patches for each event
 * - Handle client tool handoff when server requests client-side execution
 */
import type { Operation, Channel } from 'effection'
import { call, useAbortSignal, each } from 'effection'
import { parseNDJSON } from '../ndjson'
import { BaseUrlContext } from './contexts'
import type { ChatPatch } from '../patches'
import type { Message } from '../types'
import type { SessionOptions } from './options'
import type { 
  StreamEvent, 
  ApiMessage,
  StreamResult,
  IsomorphicHandoffStreamEvent,
} from './streaming'
import type { IsomorphicToolSchema } from '../isomorphic-tools'

/**
 * Options for streamChatOnce, extending SessionOptions with isomorphic tool schemas.
 */
export interface StreamChatOptions extends SessionOptions {
  /**
   * Isomorphic tool schemas to send to the server.
   * Server will execute server parts and hand off for client-side execution.
   */
  isomorphicToolSchemas?: IsomorphicToolSchema[]

  /**
   * Client outputs from isomorphic tool execution that need server validation.
   * Sent when re-initiating after executing client-authority isomorphic tools.
   */
  isomorphicClientOutputs?: Array<{
    callId: string
    toolName: string
    params: unknown
    clientOutput: unknown
    cachedHandoff?: unknown
    usesHandoff?: boolean
  }>
}

/**
 * Perform a single streaming chat request.
 * Emits patches to the provided channel as events arrive.
 *
 * @param messages - The conversation history to send
 * @param patches - Channel to emit patches to
 * @param options - Optional configuration for the chat
 * @returns StreamResult - either complete or isomorphic_handoff
 */
export function* streamChatOnce(
  messages: ApiMessage[],
  patches: Channel<ChatPatch, void>,
  options: StreamChatOptions = {}
): Operation<StreamResult> {
  // Get abort signal scoped to this operation
  const signal = yield* useAbortSignal()

  // Determine API URL: options override > context > default
  // BaseUrlContext has a default of '/api/chat', so .get() always returns a value
  const contextBaseUrl = yield* BaseUrlContext.get()
  const baseUrl = options.baseUrl ?? contextBaseUrl ?? '/api/chat'

  // Make the streaming request
  const response = yield* call(() =>
    fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        enabledTools: options.enabledTools,
        systemPrompt: options.systemPrompt,
        persona: options.persona,
        personaConfig: options.personaConfig,
        enableOptionalTools: options.enableOptionalTools,
        effort: options.effort,
        // Include isomorphic tool schemas
        isomorphicTools: options.isomorphicToolSchemas,
        // Include client outputs from isomorphic tools that need server validation
        isomorphicClientOutputs: options.isomorphicClientOutputs,
      }),
      signal,
    })
  )

  if (!response.ok) {
    const errorText = yield* call(() => response.text())
    let errorMessage = `Chat API error: ${response.status}`
    try {
      const json = JSON.parse(errorText)
      if (json.error) errorMessage = json.error
    } catch {
      errorMessage += ` - ${errorText}`
    }
    throw new Error(errorMessage)
  }

  if (!response.body) {
    throw new Error('No response body from chat API')
  }

  // Create Effection stream for NDJSON parsing
  // Server returns { lsn, event } wrapper format (durable streaming)
  // We parse as unknown and extract the inner event
  const eventStream = parseNDJSON<unknown>(response.body, { signal })

  // Accumulate assistant text
  let assistantText = ''
  
  // Collect isomorphic handoff events (multiple can arrive before stream ends)
  const isomorphicHandoffs: IsomorphicHandoffStreamEvent[] = []
  // Collect conversation state (sent when isomorphic tools are involved)
  let conversationState: any | null = null
  // Track tool results from phase 2 processing (for history sync)
  const toolResults: Array<{ id: string; name: string; content: string }> = []
  // Track tool calls for history sync
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = []

  // Consume the stream using Effection's each() pattern
  // Important: must call yield* each.next() at end of each iteration
  for (const rawEvent of yield* each(eventStream)) {
    // Unwrap durable format: { lsn: number, event: StreamEvent } -> StreamEvent
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
          type: 'streaming_thinking',
          content: event.content,
        })
        break

      case 'tool_calls':
        for (const call of event.calls) {
          // Track for history sync
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
        // Track for history sync (especially important for phase 2 tools)
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
        // Final text from server (authoritative)
        assistantText = event.text
        break
        
      case 'isomorphic_handoff':
        // Collect isomorphic handoffs - we'll return them all at the end
        isomorphicHandoffs.push(event)
        // Emit state patch for UI updates
        yield* patches.send({
          type: 'isomorphic_tool_state',
          id: event.callId,
          state: 'awaiting_client_approval',
          authority: event.authority,
          serverOutput: event.serverOutput,
        })
        break

      case 'conversation_state':
        // Store conversation state for isomorphic tool processing
        conversationState = event.conversationState
        break

      case 'error':
        yield* patches.send({ type: 'error', message: event.message })
        if (!event.recoverable) {
          throw new Error(event.message)
        }
        break
    }

    yield* each.next()
  }
  
  // After stream ends, check if we have isomorphic handoffs
  if (isomorphicHandoffs.length > 0) {
    // Return isomorphic handoff result - session will execute client parts
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
    // Include tool history for session to sync to history
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  }
}

/**
 * Helper to convert ChatMessage[] to API format.
 * 
 * IMPORTANT: This must preserve tool_calls and tool_call_id fields
 * so that multi-turn tool conversations work correctly with all providers.
 * Without these fields, providers (especially OpenAI) can't see the tool
 * call history and can't continue tool-based conversations properly.
 */
export function toApiMessages(messages: Message[]): ApiMessage[] {
  return messages.map((m) => {
    const apiMsg: ApiMessage = {
      role: m.role,
      content: m.content,
    }
    
    // Preserve tool_calls on assistant messages
    if (m.tool_calls && m.tool_calls.length > 0) {
      apiMsg.tool_calls = m.tool_calls
    }
    
    // Preserve tool_call_id on tool result messages
    if (m.tool_call_id) {
      apiMsg.tool_call_id = m.tool_call_id
    }
    
    return apiMsg
  })
}
