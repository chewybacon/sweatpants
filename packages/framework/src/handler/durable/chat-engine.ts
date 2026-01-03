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
import type { ChatEvent, ChatResult } from '../../lib/chat/types'
import type { IsomorphicToolSchema } from '../../lib/chat/isomorphic-tools'
import type { StreamEvent, ChatMessage } from '../types'
import type {
  ChatEngineParams,
  ChatEngine,
  ToolCall,
  ToolSchema,
  ToolRegistry,
  IsomorphicTool,
  ToolExecutionResult,
  IsomorphicClientOutput,
} from './types'

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
 * Convert a ChatEvent from the provider to a StreamEvent.
 */
function providerEventToStreamEvent(event: ChatEvent): StreamEvent | null {
  switch (event.type) {
    case 'text':
      return { type: 'text', text: event.content }
    case 'thinking':
      return { type: 'thinking', text: event.content }
    case 'tool_calls':
      return {
        type: 'tool_calls',
        calls: event.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      }
    default:
      return null
  }
}

/**
 * Convert a tool execution result to a StreamEvent.
 */
function toolResultToStreamEvent(result: ToolExecutionResult): StreamEvent {
  if (!result.ok) {
    return {
      type: 'tool_error',
      id: result.error.callId,
      name: result.error.toolName,
      message: result.error.message,
    }
  }

  if (result.kind === 'handoff') {
    return result.handoff
  }

  const content =
    typeof result.serverOutput === 'string'
      ? result.serverOutput
      : JSON.stringify(result.serverOutput)

  return {
    type: 'tool_result',
    id: result.callId,
    name: result.toolName,
    content,
  }
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
    authority: schema.authority ?? 'server',
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
  schemaByName: Map<string, ToolSchema>,
  signal: AbortSignal
): Operation<ToolExecutionResult> {
  const toolName = toolCall.function.name
  const tool = registry.get(toolName)

  // Check for client-only tool
  if (!tool) {
    const schema = schemaByName.get(toolName)
    if (schema?.authority === 'client') {
      return {
        ok: true,
        kind: 'handoff',
        callId: toolCall.id,
        toolName,
        handoff: {
          type: 'isomorphic_handoff',
          callId: toolCall.id,
          toolName,
          params: toolCall.function.arguments,
          serverOutput: undefined,
          authority: 'client',
          usesHandoff: false,
        },
      }
    }

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
      return {
        ok: false,
        error: {
          callId: toolCall.id,
          toolName,
          message: `Tool "${toolName}" has no server function`,
        },
      }
    }

    const serverOutput = yield* tool.server(validatedParams, { callId: toolCall.id, signal })

    // Check if tool has client component (handoff)
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
          authority: tool.authority ?? 'server',
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
 */
function* processClientOutput(
  output: IsomorphicClientOutput,
  registry: ToolRegistry,
  schemaByName: Map<string, ToolSchema>,
  _signal: AbortSignal
): Operation<StreamEvent> {
  const tool = registry.get(output.toolName)

  // Client-only tool - just return the result
  if (!tool) {
    const schema = schemaByName.get(output.toolName)
    if (schema?.authority === 'client') {
      const content =
        typeof output.clientOutput === 'string'
          ? output.clientOutput
          : JSON.stringify(output.clientOutput)
      return {
        type: 'tool_result',
        id: output.callId,
        name: output.toolName,
        content,
      }
    }

    return {
      type: 'tool_error',
      id: output.callId,
      name: output.toolName,
      message: `Tool not found: ${output.toolName}`,
    }
  }

  // Phase 2: Execute server's after() with client output
  try {
    // For now, just use client output as the result
    // TODO: Implement full phase 2 with handoff config
    const content =
      typeof output.clientOutput === 'string'
        ? output.clientOutput
        : JSON.stringify(output.clientOutput)

    return {
      type: 'tool_result',
      id: output.callId,
      name: output.toolName,
      content,
    }
  } catch (error) {
    return {
      type: 'tool_error',
      id: output.callId,
      name: output.toolName,
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
    systemPrompt,
    toolSchemas,
    toolRegistry,
    clientIsomorphicTools,
    isomorphicClientOutputs,
    provider,
    maxIterations,
    signal,
    sessionInfo,
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

  // Tool names set for filtering
  const toolNames = new Set(allSchemas.map((t) => t.name))

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
    }

    // Prepend system prompt if provided
    if (systemPrompt) {
      state.conversationMessages.unshift({
        role: 'system',
        content: systemPrompt,
      })
    }

    // Helper to convert provider tool calls to our format
    const convertToolCalls = (calls: ChatResult['toolCalls']): ToolCall[] => {
      if (!calls) return []
      return calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }))
    }

    // The subscription we provide to consumers
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        // Check abort signal
        if (signal.aborted) {
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
              state.phase = isomorphicClientOutputs.length > 0 ? 'process_client_outputs' : 'start_iteration'
              return { done: false, value: sessionInfo }
            }
            state.phase = isomorphicClientOutputs.length > 0 ? 'process_client_outputs' : 'start_iteration'
            return yield* this.next()
          }

          case 'process_client_outputs': {
            // Process all client outputs and buffer the events
            for (const output of isomorphicClientOutputs) {
              const event = yield* processClientOutput(output, toolRegistry, schemaByName, signal)
              state.pendingEvents.push(event)

              // Also add to conversation messages if it's a result
              if (event.type === 'tool_result') {
                // Find existing tool message or add new one
                let found = false
                for (const msg of state.conversationMessages) {
                  if (msg.role === 'tool' && msg.tool_call_id === output.callId) {
                    msg.content = event.content
                    found = true
                    break
                  }
                }
                if (!found) {
                  state.conversationMessages.push({
                    role: 'tool',
                    tool_call_id: output.callId,
                    content: event.content,
                  })
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

            // Convert provider event to stream event
            const streamEvent = providerEventToStreamEvent(result.value)
            if (streamEvent) {
              return { done: false, value: streamEvent }
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
              // Filter to known tools and convert
              const allCalls = convertToolCalls(result.toolCalls)
              state.toolCalls = allCalls.filter((tc) => toolNames.has(tc.function.name))
              state.toolResults = []
              state.phase = 'executing_tools'
              return yield* this.next()
            }

            // No tool calls - complete
            state.phase = 'complete'
            const completeEvent: StreamEvent = {
              type: 'complete',
              text: result.text,
              ...(result.usage && {
                usage: {
                  prompt_tokens: result.usage.promptTokens,
                  completion_tokens: result.usage.completionTokens,
                  total_tokens: result.usage.totalTokens,
                },
              }),
            }
            state.pendingEvents.push(completeEvent)
            return { done: false, value: state.pendingEvents.shift()! }
          }

          case 'executing_tools': {
            const toolCalls = state.toolCalls || []
            const results: ToolExecutionResult[] = []

            // Execute all tools and collect results
            for (const tc of toolCalls) {
              const result = yield* executeToolCall(tc, toolRegistry, schemaByName, signal)
              results.push(result)
              state.pendingEvents.push(toolResultToStreamEvent(result))
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

            // Check for handoffs
            const handoffResults = results.filter((r) => r.ok && r.kind === 'handoff')

            if (handoffResults.length > 0) {
              // Hand off to client - emit conversation state and stop
              state.phase = 'handoff_pending'

              const conversationState: StreamEvent = {
                type: 'conversation_state',
                conversationState: {
                  messages: state.conversationMessages,
                  assistantContent: providerResult.text,
                  toolCalls: toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments as Record<string, unknown>,
                  })),
                  serverToolResults: results.map((r) => {
                    if (r.ok) {
                      if (r.kind === 'handoff') {
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
                  }),
                },
              }

              return { done: false, value: conversationState }
            }

            // No handoffs - update messages and continue loop
            // Add assistant message with tool calls
            state.conversationMessages.push({
              role: 'assistant',
              content: providerResult.text,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments as Record<string, unknown>,
                },
              })),
            })

            // Add tool result messages
            for (const r of results) {
              if (r.ok && r.kind === 'result') {
                state.conversationMessages.push({
                  role: 'tool',
                  tool_call_id: r.callId,
                  content:
                    typeof r.serverOutput === 'string'
                      ? r.serverOutput
                      : JSON.stringify(r.serverOutput),
                })
              } else if (!r.ok) {
                state.conversationMessages.push({
                  role: 'tool',
                  tool_call_id: r.error.callId,
                  content: `Error: ${r.error.message}`,
                })
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

          case 'handoff_pending': {
            // After emitting conversation_state, we're done
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
