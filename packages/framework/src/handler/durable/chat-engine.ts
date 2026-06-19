/**
 * Pull-Based Chat Engine
 *
 * A state machine that yields StreamEvent objects on demand.
 * Each call to next() advances the state machine and returns the next event.
 *
 * The engine handles:
 * - Session info emission
 * - Client output processing (phase 2 handoffs)
 * - Provider streaming (text, thinking, tool_calls)
 * - Tool execution with parallel execution and buffered results
 * - Tool loop iterations
 * - Handoff detection and conversation state emission
 * - Error handling (non-fatal continues, fatal stops)
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { resource, type Operation, type Subscription } from 'effection'
import type { ChatEvent, ChatResult } from '../../lib/chat/types.ts'
import type { IsomorphicToolSchema } from '../../lib/chat/isomorphic-tools/index.ts'
import { HandoffReadyError } from '../../lib/chat/isomorphic-tools/types.ts'
import type { ServerToolContext, ServerAuthorityContext } from '../../lib/chat/isomorphic-tools/types.ts'
import type { ToolExecutionTrace } from '../../lib/chat/isomorphic-tools/runtime/emissions.ts'
import type { StreamEvent, ChatMessage } from '../types.ts'
import type {
  ChatEngineParams,
  ChatEngine,
  ToolCall,
  ToolSchema,
  ToolRegistry,
  IsomorphicTool,
  ToolExecutionResult,
  IsomorphicClientOutput,
} from './types.ts'
import {
  getPluginForTool,
  isPluginTool,
  executePluginTool,
  pluginResultToToolResult,
} from './plugin-tool-executor.ts'
import {
  appendAssistantToolCallMessage,
  appendSystemMessage,
  appendToolMessage,
  createTranscriptState,
} from '../../lib/chat/session/transcript.ts'
import { buildAgUiCheckpoint, buildAgUiCustomState } from '../../lib/chat/session/ag-ui-checkpoint.ts'

// =============================================================================
// CONTEXT HELPERS (adapted from create-handler.ts)
// =============================================================================

/**
 * Create a Phase 1 context for server-first tools.
 * 
 * When the tool calls ctx.handoff(), we throw HandoffReadyError
 * to capture the handoff data and return it as a handoff result.
 */
function createPhase1Context(baseContext: ServerToolContext): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff(config) {
      const handoffData = yield* config.before()
      throw new HandoffReadyError(handoffData)
    },
  }
}

/**
 * Create a Phase 2 context for server-first tools.
 * 
 * After client execution, we resume the server's handoff with
 * the cached handoff data and client output.
 */
function createPhase2Context(
  baseContext: ServerToolContext,
  cachedHandoff: unknown,
  clientOutput: unknown
): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff(config) {
      return yield* config.after(cachedHandoff as never, clientOutput as never)
    },
  }
}

// =============================================================================
// INTERNAL STATE TYPES
// =============================================================================

interface EngineState {
  phase: string
  iteration: number
  conversationMessages: ChatMessage[]
  pendingEvents: StreamEvent[]
  providerSubscription: Subscription<ChatEvent, ChatResult> | null
  providerResult: ChatResult | null
  toolCalls: ToolCall[] | null
  toolResults: ToolExecutionResult[] | null
  error: Error | null
  // Plugin session state
  pendingPluginSessions: Map<string, { callId: string; toolName: string }>
  awaitingElicitResult: ToolExecutionResult | null
  assistantMessageId: string | null
  assistantTextOpen: boolean
  toolLifecycleEmitted: boolean
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Validate tool parameters using the tool's Zod schema.
 */
function validateToolParams(tool: IsomorphicTool, params: unknown): unknown {
  try {
    return tool.parameters.parse(params)
  } catch {
    // Return as-is if validation fails - let the tool handle it
    return params
  }
}

/**
 * Convert a ChatEvent from the provider to AG-UI StreamEvents.
 *
 * Text tokens are emitted incrementally as `ag_ui_text_message_content` events.
 * The first text token also triggers `ag_ui_text_message_start`.
 * Thinking tokens are passed through as `thinking` events.
 * Tool call events are ignored here — tool lifecycle is emitted at `tools_complete`.
 */
function providerEventToAgUiStreamEvents(
  event: ChatEvent,
  state: EngineState,
  agUiRun: { threadId: string; runId: string; parentRunId?: string },
): StreamEvent[] {
  switch (event.type) {
    case 'text': {
      const events: StreamEvent[] = []
      if (!state.assistantTextOpen) {
        // Assign a deterministic message ID for the streamed assistant message
        state.assistantMessageId ??= `assistant:final:${agUiRun.runId}`
        state.assistantTextOpen = true
        events.push({
          type: 'ag_ui_text_message_start',
          messageId: state.assistantMessageId,
          role: 'assistant' as const,
        })
      }
      events.push({
        type: 'ag_ui_text_message_content',
        messageId: state.assistantMessageId!,
        delta: event.content,
      })
      return events
    }
    case 'thinking':
      return [{ type: 'thinking', content: event.content }]
    default:
      return []
  }
}

/**
 * Convert a tool execution result to an AG-UI StreamEvent.
 *
 * - Success results emit `ag_ui_tool_call_result`
 * - Error results emit `ag_ui_tool_call_error`
 * - Handoff and elicit results pass through unchanged (they are not legacy)
 */
function toolResultToAgUiStreamEvent(result: ToolExecutionResult): StreamEvent {
  if (!result.ok) {
    return {
      type: 'ag_ui_tool_call_error',
      toolCallId: result.error.callId,
      toolCallName: result.error.toolName,
      message: result.error.message,
    }
  }

  if (result.kind === 'handoff') {
    return result.handoff
  }

  if (result.kind === 'plugin_awaiting') {
    // Plugin tool is waiting for elicitation - emit elicit request
    return {
      type: 'elicit_request',
      sessionId: result.sessionId,
      callId: result.callId,
      toolName: result.toolName,
      elicitId: result.elicitRequest.elicitId,
      key: result.elicitRequest.key,
      message: result.elicitRequest.message,
      schema: result.elicitRequest.schema,
    }
  }

  const content =
    typeof result.serverOutput === 'string'
      ? result.serverOutput
      : JSON.stringify(result.serverOutput)

  const trace: ToolExecutionTrace | undefined = 'trace' in result ? result.trace : undefined

  return {
    type: 'ag_ui_tool_call_result',
    toolCallId: result.callId,
    toolCallName: result.toolName,
    content,
    ...(trace ? { trace } : {}),
  }
}

function agUiToolLifecycleEvents(toolCalls: ToolCall[]): StreamEvent[] {
  return toolCalls.flatMap((toolCall) => [
    {
      type: 'ag_ui_tool_call_start' as const,
      toolCallId: toolCall.id,
      toolCallName: toolCall.function.name,
      parentMessageId: `assistant:tools:${toolCall.id}`,
    },
    {
      type: 'ag_ui_tool_call_args' as const,
      toolCallId: toolCall.id,
      delta: JSON.stringify(toolCall.function.arguments),
    },
    {
      type: 'ag_ui_tool_call_end' as const,
      toolCallId: toolCall.id,
    },
  ])
}

function agUiTextLifecycleEvents(messageId: string, role: 'assistant' | 'user' | 'system', text: string): StreamEvent[] {
  return [
    {
      type: 'ag_ui_text_message_start',
      messageId,
      role,
    },
    ...(text.length > 0
      ? [{
          type: 'ag_ui_text_message_content' as const,
          messageId,
          delta: text,
        }]
      : []),
    {
      type: 'ag_ui_text_message_end',
      messageId,
    },
  ]
}

/**
 * Convert ToolSchema to IsomorphicToolSchema for provider.
 */
function toIsomorphicSchema(schema: ToolSchema): IsomorphicToolSchema {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    isIsomorphic: true,
  }
}

// =============================================================================
// TOOL EXECUTION
// =============================================================================

/**
 * Execute a single tool call.
 */
function* executeToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  signal: AbortSignal
): Operation<ToolExecutionResult> {
  const toolName = toolCall.function.name
  const tool = registry.get(toolName)

  // Check for missing tool
  if (!tool) {
    return {
      ok: false,
      error: {
        callId: toolCall.id,
        toolName,
        message: `Tool not found: ${toolName}`,
      },
    }
  }

  // Execute server-side tool
  try {
    const validatedParams = validateToolParams(tool, toolCall.function.arguments)

    if (!tool.server) {
      if (tool.client) {
        return {
          ok: true,
          kind: 'handoff',
          callId: toolCall.id,
          toolName,
          handoff: {
            type: 'isomorphic_handoff',
            callId: toolCall.id,
            toolName,
            params: validatedParams,
            serverOutput: undefined,
            usesHandoff: false,
          },
          serverOutput: undefined,
        }
      }

      return {
        ok: false,
        error: {
          callId: toolCall.id,
          toolName,
          message: `Tool "${toolName}" has no server or client function`,
        },
      }
    }

    // Create the proper Phase 1 context with handoff() method
    const baseContext: ServerToolContext = { callId: toolCall.id, signal }
    const phase1Context = createPhase1Context(baseContext)

    const serverOutput = yield* tool.server(validatedParams, phase1Context)

    // If we get here without HandoffReadyError, tool completed without handoff
    // Check if tool has client component (legacy handoff pattern)
    if (tool.client) {
      return {
        ok: true,
        kind: 'handoff',
        callId: toolCall.id,
        toolName,
        handoff: {
          type: 'isomorphic_handoff',
          callId: toolCall.id,
          toolName,
          params: validatedParams,
          serverOutput,
          usesHandoff: true,
        },
        serverOutput,
      }
    }

    return {
      ok: true,
      kind: 'result',
      callId: toolCall.id,
      toolName,
      serverOutput,
    }
  } catch (error) {
    // Handle handoff request from ctx.handoff()
    if (error instanceof HandoffReadyError) {
      const validatedParams = validateToolParams(tool, toolCall.function.arguments)
      return {
        ok: true,
        kind: 'handoff',
        callId: toolCall.id,
        toolName,
        handoff: {
          type: 'isomorphic_handoff',
          callId: toolCall.id,
          toolName,
          params: validatedParams,
          serverOutput: error.handoffData,
          usesHandoff: true,
        },
        serverOutput: error.handoffData,
      }
    }

    return {
      ok: false,
      error: {
        callId: toolCall.id,
        toolName,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Process client outputs from phase 1 handoffs (phase 2 execution).
 * Returns AG-UI tool call result/error events.
 */
function* processClientOutput(
  output: IsomorphicClientOutput,
  registry: ToolRegistry,
  _signal: AbortSignal
): Operation<StreamEvent> {
  const tool = registry.get(output.toolName)

  if (!tool) {
    return {
      type: 'ag_ui_tool_call_error',
      toolCallId: output.callId,
      toolCallName: output.toolName,
      message: `Tool not found: ${output.toolName}`,
    }
  }

  // Phase 2: Execute server's after() with client output
  try {
    // If tool has a server function, run it with Phase 2 context
    // This re-enters the tool's server function with handoff() configured
    // to call config.after() instead of config.before()
    if (tool.server && output.usesHandoff) {
      const baseContext: ServerToolContext = { callId: output.callId, signal: _signal }
      const phase2Context = createPhase2Context(
        baseContext,
        output.cachedHandoff,
        output.clientOutput
      )
      
      // Re-run the server function - it will call ctx.handoff() which now
      // returns the result of config.after(cachedHandoff, clientOutput)
      const validatedParams = validateToolParams(tool, output.params)
      const serverResult = yield* tool.server(validatedParams, phase2Context)
      
      const content =
        typeof serverResult === 'string'
          ? serverResult
          : JSON.stringify(serverResult)

      return {
        type: 'ag_ui_tool_call_result',
        toolCallId: output.callId,
        toolCallName: output.toolName,
        content,
        ...(output.trace && { trace: output.trace }),
      }
    }

    // Fallback: just use client output as the result
    const content =
      typeof output.clientOutput === 'string'
        ? output.clientOutput
        : JSON.stringify(output.clientOutput)

    return {
      type: 'ag_ui_tool_call_result',
      toolCallId: output.callId,
      toolCallName: output.toolName,
      content,
      ...(output.trace && { trace: output.trace }),
    }
  } catch (error) {
    return {
      type: 'ag_ui_tool_call_error',
      toolCallId: output.callId,
      toolCallName: output.toolName,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

// =============================================================================
// CHAT ENGINE FACTORY
// =============================================================================

/**
 * Create a pull-based chat engine.
 *
 * The engine is a Stream that yields StreamEvent objects.
 * Each call to next() advances the internal state machine.
 *
 * @param params - Engine configuration
 * @returns A Stream of StreamEvent that can be pulled from
 */
export function createChatEngine(params: ChatEngineParams): ChatEngine {
  const {
    messages,
    replayState,
    systemPrompt,
    toolSchemas,
    toolRegistry,
    clientIsomorphicTools,
    isomorphicClientOutputs,
    provider,
    maxIterations,
    signal,
    sessionInfo,
    agUiRun,
    pluginRegistry,
    pluginEmissionChannel,
    mcpToolRegistry,
    pluginSessionManager,
    elicitResponses,
    pluginAbort,
  } = params

  // Build schema lookup map
  const schemaByName = new Map<string, ToolSchema>()
  for (const schema of [...toolSchemas, ...clientIsomorphicTools]) {
    schemaByName.set(schema.name, schema)
  }

  // Build tool options for provider - convert to IsomorphicToolSchema
  const allSchemas = [...toolSchemas, ...clientIsomorphicTools]
  const combinedTools =
    allSchemas.length > 0
      ? { isomorphicToolSchemas: allSchemas.map(toIsomorphicSchema) }
      : undefined

  // Tool names set for filtering. Some providers approximate generated tool
  // names (for example, emitting `book-flight` or `book_flight` for
  // `book-flight_book_flight`). Keep the ordered list for unique alias
  // reconciliation before filtering unsupported calls.
  const toolNames = new Set(allSchemas.map((t) => t.name))
  const toolNameList = allSchemas.map((t) => t.name)

  return resource(function* (provide) {
    // Initialize state
    const state: EngineState = {
      phase: 'init',
      iteration: 0,
      conversationMessages: [...messages],
      pendingEvents: [],
      providerSubscription: null,
      providerResult: null,
      toolCalls: null,
      toolResults: null,
      error: null,
      pendingPluginSessions: new Map(),
      awaitingElicitResult: null,
      assistantMessageId: null,
      assistantTextOpen: false,
      toolLifecycleEmitted: false,
    }
    const conversationTranscriptState = createTranscriptState(state.conversationMessages)

    // Prepend system prompt if provided
    if (systemPrompt) {
      appendSystemMessage(state.conversationMessages, conversationTranscriptState, systemPrompt)
    }

    const replayToolTraceMap = new Map(
      (replayState?.toolTraces ?? []).map((trace) => [trace.callId, trace]),
    )

    function sanitizeToolCallIdPart(value: string): string {
      return value.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
    }

    function collectUsedToolCallIds(): Set<string> {
      const ids = new Set<string>()

      for (const message of state.conversationMessages) {
        for (const toolCall of message.tool_calls ?? []) {
          const id = (toolCall as { id?: unknown }).id
          if (typeof id === 'string' && id.trim().length > 0) {
            ids.add(id)
          }
        }

        const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id
        if (typeof toolCallId === 'string' && toolCallId.trim().length > 0) {
          ids.add(toolCallId)
        }
      }

      return ids
    }

    const resolveProviderToolName = (name: string): string | undefined => {
      if (toolNames.has(name)) return name

      const candidates = toolNameList.filter((candidate) => {
        if (candidate === name) return true
        if (candidate.startsWith(`${name}_`)) return true
        if (candidate.endsWith(`_${name}`)) return true

        const splitAt = candidate.indexOf('_')
        if (splitAt <= 0) return false
        const namespacePart = candidate.slice(0, splitAt)
        const intrinsicPart = candidate.slice(splitAt + 1)
        return name === namespacePart || name === intrinsicPart
      })

      return candidates.length === 1 ? candidates[0] : undefined
    }

    // Helper to convert provider tool calls to our format.
    // Some providers (notably Ollama-compatible APIs) can omit tool call IDs.
    // The rest of the chat/runtime stack keys plugin sessions, elicit state,
    // tool results, and UI parts by call ID, so synthesize a per-run ID when
    // the provider does not supply a usable unique one.
    const convertToolCalls = (calls: ChatResult['toolCalls']): ToolCall[] => {
      if (!calls) return []

      const usedIds = collectUsedToolCallIds()

      return calls.map((tc, index) => {
        const rawId = (tc as { id?: unknown }).id
        let id = typeof rawId === 'string' && rawId.trim().length > 0
          ? rawId
          : ''

        if (!id || usedIds.has(id)) {
          const toolName = sanitizeToolCallIdPart(tc.function.name)
          let suffix = 0
          do {
            const suffixPart = suffix === 0 ? '' : `:${suffix}`
            id = `call:${agUiRun.runId}:${state.iteration}:${index}:${toolName}${suffixPart}`
            suffix++
          } while (usedIds.has(id))
        }

        usedIds.add(id)

        return {
          id,
          type: 'function' as const,
          function: {
            name: resolveProviderToolName(tc.function.name) ?? tc.function.name,
            arguments: tc.function.arguments,
          },
        }
      })
    }

    // The subscription we provide to consumers
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        // Check abort signal - only set error if not already in done/error state
        if (signal.aborted && state.phase !== 'done' && state.phase !== 'error') {
          state.phase = 'error'
          state.error = new Error('Aborted')
        }

        // Drain pending events first
        if (state.pendingEvents.length > 0) {
          return { done: false, value: state.pendingEvents.shift()! }
        }

        // State machine
        switch (state.phase) {
          case 'init': {
            // Emit session info if provided
            if (sessionInfo) {
              // Determine next phase based on what needs processing
              if (pluginAbort) {
                state.phase = 'process_plugin_abort'
              } else if (elicitResponses && elicitResponses.length > 0) {
                state.phase = 'process_plugin_responses'
              } else if (isomorphicClientOutputs.length > 0) {
                state.phase = 'process_client_outputs'
              } else {
                state.phase = 'start_iteration'
              }
              return { done: false, value: sessionInfo }
            }
            // Same logic without session info
            if (pluginAbort) {
              state.phase = 'process_plugin_abort'
            } else if (elicitResponses && elicitResponses.length > 0) {
              state.phase = 'process_plugin_responses'
            } else if (isomorphicClientOutputs.length > 0) {
              state.phase = 'process_client_outputs'
            } else {
              state.phase = 'start_iteration'
            }
            return yield* this.next()
          }

          case 'process_plugin_abort': {
            // Handle explicit abort request
            if (pluginAbort && pluginSessionManager) {
              const { sessionId, reason } = pluginAbort
              
              try {
                yield* pluginSessionManager.abort(sessionId, reason)
                
                // Emit abort confirmation event
                state.pendingEvents.push({
                  type: 'tool_session_status',
                  sessionId,
                  callId: sessionId, // sessionId is the callId
                  toolName: '', // We don't have this info readily available
                  status: 'aborted',
                })
              } catch (_error) {
                // Session might not exist - emit error
                state.pendingEvents.push({
                  type: 'tool_session_error',
                  sessionId,
                  callId: sessionId,
                  error: 'SESSION_NOT_FOUND',
                  message: `Plugin session ${sessionId} not found`,
                })
              }
            }
            
            // Move to next phase
            if (elicitResponses && elicitResponses.length > 0) {
              state.phase = 'process_plugin_responses'
            } else if (isomorphicClientOutputs.length > 0) {
              state.phase = 'process_client_outputs'
            } else {
              state.phase = 'start_iteration'
            }
            
            // Return first pending event if any
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! }
            }
            return yield* this.next()
          }

          case 'process_plugin_responses': {
            // Resume suspended plugin sessions with elicit responses
            if (elicitResponses && pluginSessionManager) {
              for (const response of elicitResponses) {
                const { sessionId, callId, elicitId, result } = response
                
                // Look up the session (pass provider for session recovery)
                const session = yield* pluginSessionManager.get(sessionId, provider)
                
                if (!session) {
                  // Session not found - emit error
                  state.pendingEvents.push({
                    type: 'tool_session_error',
                    sessionId,
                    callId,
                    error: 'SESSION_NOT_FOUND',
                    message: `Plugin session ${sessionId} was lost. Please retry the operation.`,
                  })
                  
                  // Add synthetic tool error to conversation
                  appendToolMessage(
                    state.conversationMessages,
                    conversationTranscriptState,
                    callId,
                    'Error: Plugin session was lost. Please retry the operation.',
                  )
                  continue
                }
                
                // Convert the result to proper ElicitResult type
                let elicitResult: { action: 'accept'; content: unknown } | { action: 'decline' } | { action: 'cancel' }
                if (result.action === 'accept') {
                  elicitResult = { action: 'accept', content: result.content }
                } else if (result.action === 'decline') {
                  elicitResult = { action: 'decline' }
                } else {
                  elicitResult = { action: 'cancel' }
                }
                
                // Send the elicit response to the session
                yield* session.respondToElicit(elicitId, elicitResult)
                
                // Wait for the next event from the session
                const nextEvent = yield* session.nextEvent()
                
                if (!nextEvent) {
                  // Session completed without returning an event (shouldn't happen)
                  continue
                }
                
                switch (nextEvent.type) {
                  case 'elicit_request': {
                    // Another elicitation needed - emit event and go to awaiting phase
                    state.pendingEvents.push({
                      type: 'elicit_request',
                      sessionId,
                      callId,
                      toolName: session.toolName,
                      elicitId: nextEvent.elicitId,
                      key: nextEvent.key,
                      message: nextEvent.message,
                      schema: nextEvent.schema,
                    })
                    // Track that we're awaiting
                    state.awaitingElicitResult = {
                      ok: true,
                      kind: 'plugin_awaiting',
                      callId,
                      toolName: session.toolName,
                      sessionId,
                      elicitRequest: {
                        sessionId,
                        callId,
                        toolName: session.toolName,
                        elicitId: nextEvent.elicitId,
                        key: nextEvent.key,
                        message: nextEvent.message,
                        schema: nextEvent.schema,
                      },
                    }
                    break
                  }
                  
                  case 'result': {
                    // Tool completed successfully
                    const content = typeof nextEvent.result === 'string'
                      ? nextEvent.result
                      : JSON.stringify(nextEvent.result)
                    
                    state.pendingEvents.push({
                      type: 'ag_ui_tool_call_result',
                      toolCallId: callId,
                      toolCallName: session.toolName,
                      content,
                    })
                    
                    // Add to conversation
                    appendToolMessage(
                      state.conversationMessages,
                      conversationTranscriptState,
                      callId,
                      content,
                    )
                    break
                  }
                  
                  case 'error': {
                    // Tool failed
                    state.pendingEvents.push({
                      type: 'ag_ui_tool_call_error',
                      toolCallId: callId,
                      toolCallName: session.toolName,
                      message: nextEvent.message,
                    })
                    
                    // Add to conversation
                    appendToolMessage(
                      state.conversationMessages,
                      conversationTranscriptState,
                      callId,
                      `Error: ${nextEvent.message}`,
                    )
                    break
                  }
                  
                  case 'cancelled': {
                    // Tool was cancelled
                    state.pendingEvents.push({
                      type: 'ag_ui_tool_call_error',
                      toolCallId: callId,
                      toolCallName: session.toolName,
                      message: nextEvent.reason ?? 'Tool execution was cancelled',
                    })
                    break
                  }
                }
              }
            }
            
            // Check if we need to await more elicitation
            if (state.awaitingElicitResult) {
              state.phase = 'awaiting_elicit'
            } else if (isomorphicClientOutputs.length > 0) {
              state.phase = 'process_client_outputs'
            } else {
              state.phase = 'start_iteration'
            }
            
            // Return first pending event if any
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! }
            }
            return yield* this.next()
          }

          case 'process_client_outputs': {
            // Process all client outputs and buffer the events
            for (const output of isomorphicClientOutputs) {
              const event = yield* processClientOutput(output, toolRegistry, signal)
              state.pendingEvents.push(event)

              if (output.trace) {
                replayToolTraceMap.set(output.callId, {
                  callId: output.callId,
                  toolName: output.toolName,
                  trace: output.trace,
                })
              }

              // Also add to conversation messages if it's a result
              if (event.type === 'ag_ui_tool_call_result') {
                // Find existing tool message or add new one
                let found = false
                for (const msg of state.conversationMessages) {
                  if (msg.role === 'tool' && msg.tool_call_id === output.callId) {
                    msg.content = event.content
                    if (output.trace) {
                      ;(msg as typeof msg & {
                        replay?: {
                          toolName: string
                          trace: ToolExecutionTrace
                        }
                      }).replay = {
                        toolName: output.toolName,
                        trace: output.trace,
                      }
                    }
                    found = true
                    break
                  }
                }
                if (!found) {
                  appendToolMessage(
                    state.conversationMessages,
                    conversationTranscriptState,
                    output.callId,
                    event.content,
                    output.trace
                      ? {
                          toolName: output.toolName,
                          trace: output.trace,
                        }
                      : undefined,
                  )
                }
              }
            }

            state.phase = 'start_iteration'

            // Return first pending event
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! }
            }
            return yield* this.next()
          }

          case 'start_iteration': {
            state.iteration++

            if (state.iteration > maxIterations) {
              state.phase = 'error'
              state.error = new Error('Max tool iterations reached')
              return yield* this.next()
            }

            // Start streaming from provider
            const providerStream = provider.stream(state.conversationMessages, combinedTools)
            state.providerSubscription = yield* providerStream
            state.phase = 'streaming_provider'
            return yield* this.next()
          }

          case 'streaming_provider': {
            if (!state.providerSubscription) {
              state.phase = 'error'
              state.error = new Error('No provider subscription')
              return yield* this.next()
            }

            const result = yield* state.providerSubscription.next()

            if (result.done) {
              // Provider finished - result.value is ChatResult
              state.providerResult = result.value
              state.phase = 'provider_complete'
              return yield* this.next()
            }

            // Convert provider event to AG-UI stream events
            const streamEvents = providerEventToAgUiStreamEvents(result.value, state, agUiRun)
            if (streamEvents.length > 0) {
              // Queue all events except the first, return the first immediately
              for (let i = 1; i < streamEvents.length; i++) {
                state.pendingEvents.push(streamEvents[i]!)
              }
              return { done: false, value: streamEvents[0]! }
            }

            // Unknown event type, continue
            return yield* this.next()
          }

          case 'provider_complete': {
            const result = state.providerResult
            if (!result) {
              state.phase = 'error'
              state.error = new Error('No provider result')
              return yield* this.next()
            }

            if (result.toolCalls && result.toolCalls.length > 0) {
              // Close the assistant text lifecycle if it was opened during streaming
              if (state.assistantTextOpen) {
                state.pendingEvents.push({
                  type: 'ag_ui_text_message_end',
                  messageId: state.assistantMessageId!,
                })
                state.assistantTextOpen = false
              }
              // Convert and filter to known tools. Some real providers can emit
              // malformed or unsupported tool calls. If none reconcile to a
              // supported tool, fall through to the normal no-tool completion
              // path so the run lifecycle still finishes cleanly.
              const allCalls = convertToolCalls(result.toolCalls)
              state.toolCalls = allCalls.filter((tc) => toolNames.has(tc.function.name))
              if (state.toolCalls.length > 0) {
                state.toolResults = []
                state.phase = 'executing_tools'
                return yield* this.next()
              }
            }

            // No supported tool calls - complete
            state.phase = 'complete'

            if (state.assistantTextOpen) {
              // Text was streamed incrementally — just close the lifecycle
              state.pendingEvents.push({
                type: 'ag_ui_text_message_end',
                messageId: state.assistantMessageId!,
              })
              state.assistantTextOpen = false
            } else {
              // No text was streamed (edge case: empty response or provider gave no text events)
              // Emit the full text lifecycle as a batch
              state.pendingEvents.push(
                ...agUiTextLifecycleEvents(
                  `assistant:final:${agUiRun.runId}`,
                  'assistant',
                  result.text,
                ),
              )
            }

            state.pendingEvents.push({
              type: 'ag_ui_run_finished',
              run: {
                threadId: agUiRun.threadId,
                runId: agUiRun.runId,
                ...(agUiRun.parentRunId ? { parentRunId: agUiRun.parentRunId } : {}),
              },
            })
            return { done: false, value: state.pendingEvents.shift()! }
          }

          case 'executing_tools': {
            const toolCalls = state.toolCalls || []
            const results: ToolExecutionResult[] = []

            // Execute all tools and collect results
            for (const tc of toolCalls) {
              const toolName = tc.function.name

              // Check if this is a plugin tool
              const plugin = getPluginForTool(toolName, pluginRegistry)
              const mcpTool = mcpToolRegistry?.get(toolName)

              if (plugin && mcpTool && isPluginTool(mcpTool)) {
                // Execute as plugin tool
                if (pluginSessionManager) {
                  // Use session manager for durable execution
                  const session = yield* pluginSessionManager.create({
                    tool: mcpTool,
                    params: tc.function.arguments,
                    callId: tc.id,
                    provider,
                    emissionChannel: pluginEmissionChannel,
                    signal,
                  })
                  
                  // Track the session
                  state.pendingPluginSessions.set(tc.id, {
                    callId: tc.id,
                    toolName: toolName,
                  })
                  
                  // Wait for first event from the session
                  const event = yield* session.nextEvent()
                  
                  if (!event) {
                    // Session ended without event - shouldn't happen
                    results.push({
                      ok: false,
                      error: {
                        callId: tc.id,
                        toolName,
                        message: 'Plugin session ended unexpectedly',
                      },
                    })
                  } else if (event.type === 'elicit_request') {
                    // Tool needs elicitation
                    const result: ToolExecutionResult = {
                      ok: true,
                      kind: 'plugin_awaiting',
                      callId: tc.id,
                      toolName,
                      sessionId: session.id,
                      elicitRequest: {
                        sessionId: session.id,
                        callId: tc.id,
                        toolName,
                        elicitId: event.elicitId,
                        key: event.key,
                        message: event.message,
                        schema: event.schema,
                      },
                    }
                    results.push(result)
                    // Don't push to pendingEvents yet - will be handled in tools_complete
                  } else if (event.type === 'result') {
                    // Tool completed immediately (no elicitation needed)
                    results.push({
                      ok: true,
                      kind: 'result',
                      callId: tc.id,
                      toolName,
                      serverOutput: event.result,
                    })
                    state.pendingEvents.push({
                      type: 'ag_ui_tool_call_result',
                      toolCallId: tc.id,
                      toolCallName: toolName,
                      content: typeof event.result === 'string'
                        ? event.result
                        : JSON.stringify(event.result),
                    })
                    // Clean up session
                    state.pendingPluginSessions.delete(tc.id)
                  } else if (event.type === 'error') {
                    results.push({
                      ok: false,
                      error: {
                        callId: tc.id,
                        toolName,
                        message: event.message,
                      },
                    })
                    state.pendingEvents.push({
                      type: 'ag_ui_tool_call_error',
                      toolCallId: tc.id,
                      toolCallName: toolName,
                      message: event.message,
                    })
                    state.pendingPluginSessions.delete(tc.id)
                  } else if (event.type === 'cancelled') {
                    results.push({
                      ok: false,
                      error: {
                        callId: tc.id,
                        toolName,
                        message: event.reason ?? 'Tool execution was cancelled',
                      },
                    })
                    state.pendingPluginSessions.delete(tc.id)
                  }
                } else {
                  // No session manager - use direct execution (legacy path)
                  const pluginResult = yield* executePluginTool({
                    toolCall: tc,
                    tool: mcpTool,
                    plugin,
                    provider,
                    emissionChannel: pluginEmissionChannel,
                    signal,
                  })
                  const result = pluginResultToToolResult(pluginResult)
                  results.push(result)
                  state.pendingEvents.push(toolResultToAgUiStreamEvent(result))
                }
              } else {
                // Execute as regular isomorphic tool
                const result = yield* executeToolCall(tc, toolRegistry, signal)
                results.push(result)
                state.pendingEvents.push(toolResultToAgUiStreamEvent(result))
              }
            }

            state.toolResults = results
            state.phase = 'tools_complete'

            // Return first pending event
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! }
            }
            return yield* this.next()
          }

          case 'tools_complete': {
            const toolCalls = state.toolCalls || []
            const results = state.toolResults || []
            const providerResult = state.providerResult!

            // Check for plugin tools awaiting elicitation
            const pluginAwaitingResults = results.filter((r) => r.ok && r.kind === 'plugin_awaiting')
            
            if (pluginAwaitingResults.length > 0) {
              // CRITICAL: Add assistant message with tool_calls to conversationMessages
              // BEFORE going to awaiting_elicit. This ensures the conversation
              // state includes the tool call that's awaiting elicitation, so when the
              // client syncs and sends the next request, the LLM sees the proper
              // tool_call -> tool_result sequence. Without this, multi-turn elicit
              // conversations (like tictactoe) fail with "No tool call found" errors.
              appendAssistantToolCallMessage(
                state.conversationMessages,
                conversationTranscriptState,
                toolCalls,
                providerResult.text,
              )
              state.pendingEvents.push(...agUiToolLifecycleEvents(toolCalls))
              
              // Plugin tool(s) need elicitation - emit elicit events and transition
              for (const r of pluginAwaitingResults) {
                if (r.ok && r.kind === 'plugin_awaiting') {
                  state.pendingEvents.push({
                    type: 'elicit_request',
                    sessionId: r.sessionId,
                    callId: r.callId,
                    toolName: r.toolName,
                    elicitId: r.elicitRequest.elicitId,
                    key: r.elicitRequest.key,
                    message: r.elicitRequest.message,
                    schema: r.elicitRequest.schema,
                  })
                  state.awaitingElicitResult = r
                }
              }
              state.phase = 'awaiting_elicit'
              
              // Return first pending event
              if (state.pendingEvents.length > 0) {
                return { done: false, value: state.pendingEvents.shift()! }
              }
              return yield* this.next()
            }

            // Check for handoffs
            const handoffResults = results.filter((r) => r.ok && r.kind === 'handoff')

            if (handoffResults.length > 0) {
              // Hand off to client - emit AG-UI checkpoint and stop
              state.phase = 'handoff_pending'

              const serverToolResults = results.map((r) => {
                if (r.ok) {
                  if (r.kind === 'handoff') {
                    return { id: r.callId, name: r.toolName, content: '', isError: false }
                  }
                  if (r.kind === 'plugin_awaiting') {
                    return { id: r.callId, name: r.toolName, content: '', isError: false }
                  }
                  return {
                    id: r.callId,
                    name: r.toolName,
                    content:
                      typeof r.serverOutput === 'string'
                        ? r.serverOutput
                        : JSON.stringify(r.serverOutput),
                    isError: false,
                  }
                }
                return {
                  id: r.error.callId,
                  name: r.error.toolName,
                  content: `Error: ${r.error.message}`,
                  isError: true,
                }
              })

              state.pendingEvents.push({
                type: 'ag_ui_state_snapshot',
                run: {
                  threadId: agUiRun.threadId,
                  runId: agUiRun.runId,
                  ...(agUiRun.parentRunId ? { parentRunId: agUiRun.parentRunId } : {}),
                },
                state: buildAgUiCustomState({
                  ...(replayToolTraceMap.size > 0
                    ? {
                        replay: {
                          toolTraces: Array.from(replayToolTraceMap.values()),
                        },
                      }
                    : {}),
                  handoffs: handoffResults
                    .filter((r): r is Extract<typeof handoffResults[number], { ok: true; kind: 'handoff' }> => r.ok && r.kind === 'handoff')
                    .map((r) => r.handoff),
                }),
              })
              state.pendingEvents.push({
                type: 'ag_ui_checkpoint',
                checkpoint: buildAgUiCheckpoint({
                  threadId: agUiRun.threadId,
                  runId: agUiRun.runId,
                  ...(agUiRun.parentRunId ? { parentRunId: agUiRun.parentRunId } : {}),
                  messages: state.conversationMessages,
                  assistantContent: providerResult.text,
                  toolCalls,
                  serverToolResults,
                  ...(replayToolTraceMap.size > 0
                    ? {
                        replay: {
                          toolTraces: Array.from(replayToolTraceMap.values()),
                        },
                      }
                    : {}),
                }),
              })

              return { done: false, value: state.pendingEvents.shift()! }
            }

            // No handoffs - update messages and continue loop
            // Add assistant message with tool calls
            appendAssistantToolCallMessage(
              state.conversationMessages,
              conversationTranscriptState,
              toolCalls,
              providerResult.text,
            )
            state.pendingEvents.push(...agUiToolLifecycleEvents(toolCalls))

            // Add tool result messages
            for (const r of results) {
              if (r.ok && r.kind === 'result') {
                appendToolMessage(
                  state.conversationMessages,
                  conversationTranscriptState,
                  r.callId,
                  typeof r.serverOutput === 'string'
                    ? r.serverOutput
                    : JSON.stringify(r.serverOutput),
                )
              } else if (!r.ok) {
                appendToolMessage(
                  state.conversationMessages,
                  conversationTranscriptState,
                  r.error.callId,
                  `Error: ${r.error.message}`,
                )
              }
            }

            // Reset for next iteration
            state.toolCalls = null
            state.toolResults = null
            state.providerResult = null
            state.providerSubscription = null
            state.phase = 'start_iteration'

            return yield* this.next()
          }

          case 'awaiting_elicit': {
            // A tool is awaiting elicitation
            // Emit conversation state for client to render UI and send response
            let toolCalls = state.toolCalls || []
            const results = state.toolResults || []
            const providerResult = state.providerResult
            
            // CRITICAL FIX: If toolCalls is empty but we have an awaiting elicit result,
            // extract the tool call info from conversationMessages. This happens when
            // resuming from elicitation - the original state.toolCalls was set during
            // the first request's provider_streaming phase, but on subsequent requests
            // (elicit responses), we create a new engine with fresh state.
            if (
              toolCalls.length === 0 &&
              state.awaitingElicitResult?.ok &&
              state.awaitingElicitResult.kind === 'plugin_awaiting'
            ) {
              // Find the assistant message that owns the currently awaited tool call.
              // Conversation history can contain prior completed plugin calls; using
              // the first assistant with tool calls can attach the new elicitation UI
              // to stale tool-call parts from an earlier turn.
              const awaitedCallId = state.awaitingElicitResult.callId
              const assistantWithToolCalls = [...state.conversationMessages].reverse().find(
                msg => msg.role === 'assistant' &&
                  msg.tool_calls?.some((toolCall) => toolCall.id === awaitedCallId)
              ) ?? [...state.conversationMessages].reverse().find(
                msg => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0
              )
              if (assistantWithToolCalls && assistantWithToolCalls.tool_calls) {
                toolCalls = assistantWithToolCalls.tool_calls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }))
              }
            }
            
            const serverToolResults = results.map((r) => {
                if (r.ok) {
                  if (r.kind === 'handoff' || r.kind === 'plugin_awaiting') {
                    return { id: r.callId, name: r.toolName, content: '', isError: false }
                  }
                  return {
                    id: r.callId,
                    name: r.toolName,
                    content:
                      typeof r.serverOutput === 'string'
                        ? r.serverOutput
                        : JSON.stringify(r.serverOutput),
                    isError: false,
                  }
                }
                return {
                  id: r.error.callId,
                  name: r.error.toolName,
                  content: `Error: ${r.error.message}`,
                  isError: true,
                }
              })

            state.pendingEvents.push({
              type: 'ag_ui_state_snapshot',
              run: {
                threadId: agUiRun.threadId,
                runId: agUiRun.runId,
                ...(agUiRun.parentRunId ? { parentRunId: agUiRun.parentRunId } : {}),
              },
              state: buildAgUiCustomState({
                ...(replayToolTraceMap.size > 0
                  ? {
                      replay: {
                        toolTraces: Array.from(replayToolTraceMap.values()),
                      },
                    }
                  : {}),
                elicits: state.awaitingElicitResult && state.awaitingElicitResult.ok && state.awaitingElicitResult.kind === 'plugin_awaiting'
                  ? [{
                      type: 'elicit_request' as const,
                      sessionId: state.awaitingElicitResult.sessionId,
                      callId: state.awaitingElicitResult.callId,
                      toolName: state.awaitingElicitResult.toolName,
                      elicitId: state.awaitingElicitResult.elicitRequest.elicitId,
                      key: state.awaitingElicitResult.elicitRequest.key,
                      message: state.awaitingElicitResult.elicitRequest.message,
                      schema: state.awaitingElicitResult.elicitRequest.schema,
                    }]
                  : [],
              }),
            })
            state.pendingEvents.push({
              type: 'ag_ui_checkpoint',
              checkpoint: buildAgUiCheckpoint({
                threadId: agUiRun.threadId,
                runId: agUiRun.runId,
                ...(agUiRun.parentRunId ? { parentRunId: agUiRun.parentRunId } : {}),
                messages: state.conversationMessages,
                assistantContent: providerResult?.text ?? '',
                toolCalls,
                serverToolResults,
                ...(replayToolTraceMap.size > 0
                  ? {
                      replay: {
                        toolTraces: Array.from(replayToolTraceMap.values()),
                      },
                    }
                  : {}),
              }),
            })
            
            state.phase = 'handoff_pending'
            
            // Return first pending event
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! }
            }
            return yield* this.next()
          }

          case 'handoff_pending': {
            // After emitting AG-UI checkpoint, we're done
            state.phase = 'done'
            return { done: true, value: undefined }
          }

          case 'complete': {
            state.phase = 'done'
            return { done: true, value: undefined }
          }

          case 'error': {
            const errorEvent: StreamEvent = {
              type: 'error',
              message: state.error?.message ?? 'Unknown error',
              recoverable: false,
            }
            state.phase = 'done'
            return { done: false, value: errorEvent }
          }

          case 'done': {
            return { done: true, value: undefined }
          }

          default: {
            state.phase = 'error'
            state.error = new Error(`Unknown phase: ${state.phase}`)
            return yield* this.next()
          }
        }
      },
    })
  })
}
