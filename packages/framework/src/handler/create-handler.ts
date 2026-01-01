/**
 * Create Chat Handler
 *
 * Factory function that creates a portable fetch handler for AI chat.
 */

// Debug flag - set via environment variable
const DEBUG_CHAT_HANDLER = process.env['DEBUG_CHAT_HANDLER'] === 'true'

import { createScope, all } from 'effection'
import { z } from 'zod'
import type { Operation } from 'effection'
import { HandoffReadyError } from '../lib/chat/isomorphic-tools/types'
import { validateToolParams } from '../lib/chat/utils'
import { ChatStreamConfigContext, ProviderContext, ToolRegistryContext, PersonaResolverContext, MaxIterationsContext } from '../lib/chat/providers/contexts'
import type {
  ChatHandlerConfig,
  ChatRequestBody,
  ChatMessage,
  IsomorphicTool,
  StreamEvent,
  ToolSchema,
  ServerToolContext,
  ServerAuthorityContext,
  ChatProviderEvent,
  ChatProviderResult,
  InitializerContext,
} from './types'

// Helper type for tool calls
interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: unknown
  }
}

interface ToolRegistry {
  get(name: string): IsomorphicTool | undefined
  has(name: string): boolean
  names(): string[]
}

function createPhase1Context(baseContext: ServerToolContext): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff(config) {
      const handoffData = yield* config.before()
      throw new HandoffReadyError(handoffData)
    },
  }
}

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

function createToolRegistry(tools: IsomorphicTool[]): ToolRegistry {
  const map = new Map<string, IsomorphicTool>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return {
    get(name: string): IsomorphicTool | undefined {
      return map.get(name)
    },
    has(name: string): boolean {
      return map.has(name)
    },
    names(): string[] {
      return Array.from(map.keys())
    },
  }
}



type ServerPartResult =
  | {
      kind: 'handoff'
      handoff: StreamEvent & { type: 'isomorphic_handoff' }
      serverOutput?: unknown
      usesHandoff: boolean
    }
  | {
      kind: 'result'
      serverOutput: unknown
    }

function* executeServerPart(
  tool: IsomorphicTool,
  callId: string,
  params: unknown,
  signal: AbortSignal
): Operation<ServerPartResult> {
  const baseContext: ServerToolContext = { callId, signal }
  const authority = tool.authority ?? 'server'

  // Validate params using the tool's schema
  const validatedParams = validateToolParams(tool, params)

  // For client authority, we don't execute server code yet
  if (authority === 'client') {
    return {
      kind: 'handoff',
      handoff: {
        type: 'isomorphic_handoff',
        callId,
        toolName: tool.name,
        params: validatedParams,
        serverOutput: undefined,
        authority,
        usesHandoff: false,
      },
      serverOutput: undefined,
      usesHandoff: false,
    }
  }

  // For server authority, execute server code now
  if (!tool.server) {
    throw new Error(`Tool "${tool.name}" has ${authority} authority but no server function`)
  }

  const phase1Context = createPhase1Context(baseContext)

  try {
    // Execute the server function
    const serverOutput = yield* tool.server(validatedParams, phase1Context)

    // If we get here, the tool completed without calling handoff()
    if (!tool.client) {
      return { kind: 'result', serverOutput }
    }

    return {
      kind: 'handoff',
      handoff: {
        type: 'isomorphic_handoff',
        callId,
        toolName: tool.name,
        params: validatedParams,
        serverOutput,
        authority,
        usesHandoff: false,
      },
      serverOutput,
      usesHandoff: false,
    }
  } catch (e) {
    if (e instanceof HandoffReadyError) {
      return {
        kind: 'handoff',
        handoff: {
          type: 'isomorphic_handoff',
          callId,
          toolName: tool.name,
          params: validatedParams,
          serverOutput: e.handoffData,
          authority,
          usesHandoff: true,
        },
        serverOutput: e.handoffData,
        usesHandoff: true,
      }
    }

    // Re-throw the error to be handled by the caller
    throw e
  }
}

function* executeServerPhase2(
  tool: IsomorphicTool,
  callId: string,
  params: unknown,
  clientOutput: unknown,
  cachedHandoff: unknown,
  signal: AbortSignal,
  usesHandoff: boolean
): Operation<unknown> {
  const authority = tool.authority ?? 'server'
  const validatedParams = validateToolParams(tool, params)

  // For client authority, run the server function with clientOutput
  if (authority === 'client') {
    if (!tool.server) {
      throw new Error(`Tool "${tool.name}" has client authority but no server function`)
    }
    const context: ServerToolContext = { callId, signal }
    return yield* tool.server(validatedParams, context, clientOutput)
  }

  // For server authority without handoff, just return cached output
  if (!usesHandoff) {
    return cachedHandoff
  }

  // For server authority with handoff, run phase 2
  if (!tool.server) {
    throw new Error(`Tool "${tool.name}" has server authority but no server function`)
  }

  const baseContext: ServerToolContext = { callId, signal }
  const phase2Context = createPhase2Context(baseContext, cachedHandoff, clientOutput)
  return yield* tool.server(validatedParams, phase2Context)
}

// =============================================================================
// STREAM HELPERS
// =============================================================================

/**
 * Consume an effection Stream with a handler for each item.
 * Returns the stream's final result.
 * 
 * This works with effection's Stream type where stream is an Operation
 * that yields a Subscription.
 */
function* consumeStream<T, R>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: any, // Accept any stream-like type
  handler: (value: T) => Operation<void>
): Operation<R> {
  const subscription = yield* stream
  let next = yield* subscription.next()

  while (!next.done) {
    yield* handler(next.value as T)
    next = yield* subscription.next()
  }

  return next.value as R
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Create a portable fetch handler for AI chat.
 */
export function createChatHandler(config: ChatHandlerConfig) {
  const {
    initializerHooks,
    maxToolIterations = 10,
  } = config



  const dedupeSchemas = (schemas: ToolSchema[]): ToolSchema[] => {
    const seen = new Set<string>()
    const result: ToolSchema[] = []
    for (const schema of schemas) {
      if (seen.has(schema.name)) continue
      seen.add(schema.name)
      result.push(schema)
    }
    return result
  }

  /**
   * The actual request handler.
   * Takes a Request and returns a Response with NDJSON stream.
   */
  return async function handler(request: Request): Promise<Response> {
    const body = (await request.json()) as ChatRequestBody

    const {
      messages,
      enabledTools,
      isomorphicTools: clientIsomorphicTools = [],
      isomorphicClientOutputs = [],
    } = body

    const initializerContext: InitializerContext = { request, body }

    const encoder = new TextEncoder()
    const clientToolNames = clientIsomorphicTools.map((t) => t.name)

    // Create the streaming response
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const [scope, destroy] = createScope()

        const abortHandler = () => destroy()
        request.signal.addEventListener('abort', abortHandler)

        const emit = (event: StreamEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        }

        try {
          await scope.run(function* (): Operation<void> {
            // Bootup Phase: Execute initializer hooks sequentially
            for (const hook of initializerHooks) {
              yield* hook(initializerContext)
            }

            // Get dependencies from contexts (with error handling)
            const provider = yield* ProviderContext.get()
            if (!provider) {
              throw new Error('Provider not configured. Ensure a provider initializer hook sets ProviderContext.')
            }

            const tools = yield* ToolRegistryContext.get()
            if (!tools) {
              throw new Error('Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.')
            }

            const resolvePersona = yield* PersonaResolverContext.get()
            const maxIterations = (yield* MaxIterationsContext.get() ?? maxToolIterations)!

            // Create tool registry from injected tools
            const registry = createToolRegistry(tools)

            const toToolSchema = (toolName: string): ToolSchema => {
              const tool = registry.get(toolName)
              if (!tool) {
                throw new Error(`Unknown tool: ${toolName}`)
              }

              return {
                name: tool.name,
                description: tool.description,
                parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
                isIsomorphic: true,
                authority: tool.authority ?? 'server',
              }
            }

            // Determine system prompt and enabled tools
            const enabledToolNames = new Set<string>()
            let systemPrompt: string | undefined
            let sessionInfo: StreamEvent | undefined

            // Validate: Persona mode vs Manual mode
            if (body.persona && enabledTools !== undefined) {
              throw new Error('Cannot specify both "persona" and "enabledTools"')
            }

            if (body.persona) {
              // Persona Mode
              if (!resolvePersona) {
                throw new Error('Persona mode not supported - no resolver configured')
              }

              const resolved = resolvePersona(
                body.persona,
                body.personaConfig,
                body.enableOptionalTools,
                body.effort
              )

              systemPrompt = resolved.systemPrompt

              for (const toolName of resolved.tools) {
                if (registry.has(toolName)) {
                  enabledToolNames.add(toolName)
                  continue
                }
                if (clientToolNames.includes(toolName)) {
                  continue
                }
                throw new Error(`Unknown persona tool: ${toolName}`)
              }

              sessionInfo = {
                type: 'session_info',
                capabilities: {
                  ...resolved.capabilities,
                  tools: Array.from(
                    new Set([
                      ...resolved.capabilities.tools.filter(
                        (name) => registry.has(name) || clientToolNames.includes(name)
                      ),
                      ...clientToolNames,
                    ])
                  ),
                },
                persona: resolved.name,
              }
            } else {
              // Manual Mode
              // The client sends isomorphicTools schemas for tools it wants to use.
              // These are the ONLY tools that will be enabled.
              // The server registry is used to look up server implementations.
              
              // Enable tools that:
              // 1. Client requested (in clientToolNames from isomorphicTools schemas)
              // 2. Have a server implementation in the registry
              for (const name of clientToolNames) {
                if (registry.has(name)) {
                  enabledToolNames.add(name)
                }
              }

              // Legacy support: if enabledTools is provided (deprecated), merge them
              // But only enable tools that exist in the registry
              if (enabledTools === true) {
                // Enable all server-only tools (tools without client functions)
                // These don't need client registration
                for (const name of registry.names()) {
                  const tool = registry.get(name)
                  if (tool && !tool.client) {
                    enabledToolNames.add(name)
                  }
                }
              } else if (Array.isArray(enabledTools) && enabledTools.length > 0) {
                for (const name of enabledTools) {
                  if (registry.has(name)) {
                    enabledToolNames.add(name)
                  }
                }
              }

              if (body.systemPrompt) {
                systemPrompt = body.systemPrompt
              }

              sessionInfo = {
                type: 'session_info',
                capabilities: {
                  thinking: true,
                  streaming: true,
                  tools: Array.from(enabledToolNames),
                },
                persona: null,
              }
            }

            // Build final schema list
            const serverEnabledSchemas = Array.from(enabledToolNames).map(toToolSchema)
            const toolSchemas = dedupeSchemas([...serverEnabledSchemas, ...clientIsomorphicTools])
            const toolNames = new Set(toolSchemas.map((t) => t.name))
            const schemaByName = new Map(toolSchemas.map((s) => [s.name, s] as const))

            if (sessionInfo) {
              emit(sessionInfo)
            }

            const conversationMessages: ChatMessage[] = [...messages]

            // Process client outputs (phase 2)
            if (isomorphicClientOutputs.length > 0) {
              for (const clientResult of isomorphicClientOutputs) {
                const tool = registry.get(clientResult.toolName)

                if (!tool) {
                  const schema = schemaByName.get(clientResult.toolName)
                  if (schema?.authority === 'client') {
                    const validatedResult = clientResult.clientOutput

                    let found = false
                    for (const msg of conversationMessages) {
                      if (msg.role === 'tool' && msg.tool_call_id === clientResult.callId) {
                        const content =
                          typeof validatedResult === 'string'
                            ? validatedResult
                            : JSON.stringify(validatedResult)
                        msg.content = content
                        found = true

                        emit({
                          type: 'tool_result',
                          id: clientResult.callId,
                          name: clientResult.toolName,
                          content,
                        })
                        break
                      }
                    }
                    if (!found) {
                      // Tool message not found - this shouldn't happen in normal operation
                    }
                    continue
                  }

                  emit({
                    type: 'tool_error',
                    id: clientResult.callId,
                    name: clientResult.toolName,
                    message: `Tool not found: ${clientResult.toolName}`,
                  })
                  continue
                }

                try {
                  const validatedResult = yield* executeServerPhase2(
                    tool,
                    clientResult.callId,
                    clientResult.params,
                    clientResult.clientOutput,
                    clientResult.cachedHandoff,
                    request.signal,
                    clientResult.usesHandoff ?? false
                  )


                  const content =
                    typeof validatedResult === 'string'
                      ? validatedResult
                      : JSON.stringify(validatedResult)

                  // For phase 2 tools, the client doesn't send the tool message
                  // We need to ADD it here with the *after() result
                  // First, check if the message already exists (backward compatibility)
                  let found = false
                  for (const msg of conversationMessages) {
                    if (msg.role === 'tool' && msg.tool_call_id === clientResult.callId) {
                      msg.content = content
                      found = true

                      break
                    }
                  }

                  // If not found, add the tool message
                  if (!found) {

                    conversationMessages.push({
                      role: 'tool',
                      tool_call_id: clientResult.callId,
                      content,
                    })
                  }

                  emit({
                    type: 'tool_result',
                    id: clientResult.callId,
                    name: clientResult.toolName,
                    content,
                  })
                } catch (error) {
                  emit({
                    type: 'tool_error',
                    id: clientResult.callId,
                    name: clientResult.toolName,
                    message: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            }

            // Prepend system prompt
            if (systemPrompt) {
              conversationMessages.unshift({
                role: 'system',
                content: systemPrompt,
              })
            }



            const combinedTools = toolSchemas.length > 0 ? { isomorphicToolSchemas: toolSchemas as any } : undefined

            let iterations = 0

            while (iterations < maxIterations) {
              iterations++

              // Debug logging (enabled via DEBUG_CHAT_HANDLER=true)
              if (DEBUG_CHAT_HANDLER) {
                console.log('\n========== CHAT HANDLER DEBUG ==========')
                console.log(`[iteration ${iterations}] Sending to provider:`)
                console.log('Messages:', JSON.stringify(conversationMessages.map(m => ({
                  role: m.role,
                  content: typeof m.content === 'string' && m.content.length > 200 
                    ? m.content.slice(0, 200) + '...' 
                    : m.content,
                  tool_calls: m.tool_calls?.map((tc: any) => ({ id: tc.id, name: tc.function?.name })),
                  tool_call_id: m.tool_call_id,
                })), null, 2))
                console.log('Tools:', toolSchemas.map(t => t.name))
                console.log('==========================================\n')
              }

              // Provider is already injected via DI context

              // Set up per-request model override if specified
              if (body.model) {
                yield* ChatStreamConfigContext.set({
                  baseUri: 'placeholder', // Will be overridden by resolveChatStreamConfig
                  model: body.model!,
                  apiKey: null,
                  isomorphicToolSchemas: [],
                })
              }

              // Get the provider stream
              const providerResource = provider.stream(conversationMessages, combinedTools)

              // Consume the effection stream
              const result = yield* consumeStream<ChatProviderEvent, ChatProviderResult>(
                providerResource,
                function* (event: ChatProviderEvent) {
                  if (event.type === 'text' || event.type === 'thinking') {
                    emit(event)
                  }
                  if (event.type === 'tool_calls') {
                    emit({
                      type: 'tool_calls',
                      calls: event.toolCalls.map((tc: ToolCall) => ({
                        id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                      })),
                    })
                  }
                }
              )

              // Debug logging (enabled via DEBUG_CHAT_HANDLER=true)
              if (DEBUG_CHAT_HANDLER) {
                console.log('\n========== PROVIDER RESULT ==========')
                console.log('Text:', result.text?.slice(0, 200))
                console.log('Tool calls:', result.toolCalls?.map((tc: ToolCall) => ({
                  id: tc.id,
                  name: tc.function.name,
                  args: typeof tc.function.arguments === 'string' 
                    ? tc.function.arguments.slice(0, 200)
                    : JSON.stringify(tc.function.arguments).slice(0, 200),
                })))
                console.log('=====================================\n')
              }

              if (result.toolCalls?.length) {
                const toolCalls = result.toolCalls.filter((tc: ToolCall) =>
                  toolNames.has(tc.function.name)
                )

                const toolResults = toolCalls.length
                  ? yield* all(
                      toolCalls.map((tc: ToolCall) =>
                        function* () {
                          const toolName = tc.function.name
                          const tool = registry.get(toolName)

                          if (!tool) {
                            const schema = schemaByName.get(toolName)
                            if (schema?.authority === 'client') {
                              return {
                                ok: true as const,
                                kind: 'handoff' as const,
                                callId: tc.id,
                                toolName,
                                handoff: {
                                  type: 'isomorphic_handoff' as const,
                                  callId: tc.id,
                                  toolName,
                                  params: tc.function.arguments,
                                  serverOutput: undefined,
                                  authority: 'client' as const,
                                  usesHandoff: false,
                                },
                                serverOutput: undefined,
                              }
                            }

                            return {
                              ok: false as const,
                              error: {
                                callId: tc.id,
                                toolName,
                                message: `Tool not found: ${toolName}`,
                              },
                            }
                          }

                          try {
                            const serverPartResult = yield* executeServerPart(
                              tool,
                              tc.id,
                              tc.function.arguments,
                              request.signal
                            )

                            if (serverPartResult.kind === 'handoff') {
                              return {
                                ok: true as const,
                                kind: 'handoff' as const,
                                callId: tc.id,
                                toolName,
                                handoff: serverPartResult.handoff,
                                serverOutput: serverPartResult.serverOutput,
                              }
                            }

                            return {
                              ok: true as const,
                              kind: 'result' as const,
                              callId: tc.id,
                              toolName,
                              serverOutput: serverPartResult.serverOutput,
                            }
                          } catch (error) {
                            return {
                              ok: false as const,
                              error: {
                                callId: tc.id,
                                toolName,
                                message: error instanceof Error ? error.message : String(error),
                              },
                            }
                          }
                        }()
                      )
                    )
                  : []

                const handoffResults = toolResults.filter((r) => r.ok && r.kind === 'handoff')

                const toolMessages: ChatMessage[] = []

                for (const r of toolResults) {
                  if (!r.ok) {
                    emit({
                      type: 'tool_error',
                      id: r.error.callId,
                      name: r.error.toolName,
                      message: r.error.message,
                    })

                    toolMessages.push({
                      role: 'tool',
                      tool_call_id: r.error.callId,
                      content: `Error: ${r.error.message}`,
                    })
                    continue
                  }

                  if (r.kind === 'handoff') {
                    if (DEBUG_CHAT_HANDLER) {
                      console.log(`[HANDOFF] Tool ${r.toolName} (${r.callId}) handing off to client`)
                    }
                    emit(r.handoff)
                    continue
                  }

                  const content =
                    typeof r.serverOutput === 'string'
                      ? r.serverOutput
                      : JSON.stringify(r.serverOutput)

                  if (DEBUG_CHAT_HANDLER) {
                    console.log(`[TOOL RESULT] ${r.toolName} (${r.callId}):`, content.slice(0, 300))
                  }

                  emit({
                    type: 'tool_result',
                    id: r.callId,
                    name: r.toolName,
                    content,
                  })

                  toolMessages.push({
                    role: 'tool',
                    tool_call_id: r.callId,
                    content,
                  })
                }

                // Hand off to client if needed
                if (handoffResults.length > 0) {
                  const toolCallsForClient = result.toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  }))

                  const toolResultsForState = toolResults.map((r) => {
                    if (r.ok) {
                      if (r.kind === 'handoff') {
                        return {
                          id: r.callId,
                          name: r.toolName,
                          content: '',
                          isError: false,
                        }
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

                  emit({
                    type: 'conversation_state',
                    conversationState: {
                      messages: conversationMessages,
                      assistantContent: result.text,
                      toolCalls: toolCallsForClient,
                      serverToolResults: toolResultsForState,
                    },
                  })

                  return
                }

                // No handoff - continue the loop
                conversationMessages.push({
                  role: 'assistant',
                  content: result.text,
                  tool_calls: result.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: tc.function,
                  })),
                })

                conversationMessages.push(...toolMessages)
              } else {
                // No tool calls - final response
                if (result.usage) {
                  emit({
                    type: 'complete',
                    text: result.text,
                    usage: result.usage,
                  })
                } else {
                  emit({
                    type: 'complete',
                    text: result.text,
                  })
                }
                break
              }
            }

            if (iterations >= maxToolIterations) {
              emit({
                type: 'error',
                message: 'Max tool iterations reached',
                recoverable: true,
              })
            }
          })
        } catch (error) {
          emit({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
            recoverable: false,
          })
        } finally {
          request.signal.removeEventListener('abort', abortHandler)
          await destroy()
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    })
  }
}
