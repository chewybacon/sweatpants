/**
 * Durable Chat Handler
 *
 * A pull-based chat handler that buffers all stream events for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * Protocol:
 * - Request params: X-Session-Id (header/query), X-Last-LSN (header/query)
 * - Response: NDJSON with LSN in each event, X-Session-Id header
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { createScope, resource, type Operation, type Stream } from 'effection'
import { z } from 'zod'
import {
  useSessionRegistry,
  createPullStream,
} from '../../lib/chat/durable-streams'
import type { SessionRegistry, TokenFrame } from '../../lib/chat/durable-streams'
import { ProviderContext, ToolRegistryContext, PersonaResolverContext, MaxIterationsContext } from '../../lib/chat/providers/contexts'
import { bindModel, stringParam, intParam, createBindingSource } from '../model-binder'
import { createChatEngine } from './chat-engine'
import type {
  DurableChatHandlerConfig,
  ChatRequestBody,
  ToolSchema,
  ToolRegistry,
  IsomorphicTool,
} from './types'
import type { StreamEvent } from '../types'

// =============================================================================
// PROTOCOL PARAMETER BINDER
// =============================================================================

/**
 * Binder for durable stream protocol parameters.
 */
const durableParamsBinder = bindModel({
  sessionId: stringParam('x-session-id', 'sessionId'),
  lastLSN: intParam('x-last-lsn', 'lastLsn'),
})

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a tool registry from an array of tools.
 */
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

/**
 * Convert a tool to its schema representation.
 */
function toToolSchema(tool: IsomorphicTool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    isIsomorphic: true,
    authority: tool.authority ?? 'server',
  }
}

/**
 * Create a serialized event stream from the chat engine.
 * Each event is JSON-serialized for storage in the buffer.
 */
function createSerializedEventStream(
  engine: Stream<StreamEvent, void>
): Stream<string, void> {
  return resource(function* (provide) {
    const subscription = yield* engine

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const result = yield* subscription.next()
        if (result.done) {
          return { done: true, value: undefined }
        }
        return { done: false, value: JSON.stringify(result.value) }
      },
    })
  })
}

// =============================================================================
// DURABLE CHAT HANDLER
// =============================================================================

/**
 * Create a durable chat handler.
 *
 * The handler:
 * 1. Binds protocol params from request (sessionId, lastLSN)
 * 2. Runs initializer hooks to set up DI contexts
 * 3. Either reconnects to existing session or creates new one
 * 4. Streams events from buffer to response with LSN
 *
 * @param config - Handler configuration
 * @returns Fetch handler function
 */
export function createDurableChatHandler(config: DurableChatHandlerConfig) {
  const { initializerHooks, maxToolIterations = 10 } = config

  return async function handler(request: Request): Promise<Response> {
    // Parse request
    const body = (await request.json()) as ChatRequestBody
    const bindingSource = createBindingSource(request)
    const { sessionId: requestedSessionId, lastLSN } = durableParamsBinder(bindingSource)

    // Determine session ID
    const sessionId = requestedSessionId ?? crypto.randomUUID()
    const isReconnect = requestedSessionId !== undefined && lastLSN !== undefined
    const startLSN = lastLSN ?? 0

    const encoder = new TextEncoder()

    // Create the streaming response
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const [scope, destroy] = createScope()

        const abortHandler = () => destroy()
        request.signal.addEventListener('abort', abortHandler)

        try {
          await scope.run(function* (): Operation<void> {
            // Run initializer hooks
            for (const hook of initializerHooks) {
              yield* hook({ request, body })
            }

            // Get dependencies from contexts
            const provider = yield* ProviderContext.get()
            if (!provider) {
              throw new Error('Provider not configured. Ensure a provider initializer hook sets ProviderContext.')
            }

            const tools = yield* ToolRegistryContext.get()
            if (!tools) {
              throw new Error('Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.')
            }

            const resolvePersona = yield* PersonaResolverContext.get()
            const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations

            // Get session registry from durable streams context
            const registry: SessionRegistry<string> = yield* useSessionRegistry<string>()

            // Create tool registry
            const toolRegistry = createToolRegistry(tools)

            // Build tool schemas
            const clientToolNames = (body.isomorphicTools ?? []).map((t) => t.name)
            const enabledToolNames = new Set<string>()
            let systemPrompt: string | undefined
            let sessionInfo: (StreamEvent & { type: 'session_info' }) | undefined

            // Handle persona mode vs manual mode
            if (body.persona) {
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
                if (toolRegistry.has(toolName)) {
                  enabledToolNames.add(toolName)
                } else if (!clientToolNames.includes(toolName)) {
                  throw new Error(`Unknown persona tool: ${toolName}`)
                }
              }

              sessionInfo = {
                type: 'session_info',
                capabilities: {
                  ...resolved.capabilities,
                  tools: Array.from(
                    new Set([
                      ...resolved.capabilities.tools.filter(
                        (name) => toolRegistry.has(name) || clientToolNames.includes(name)
                      ),
                      ...clientToolNames,
                    ])
                  ),
                },
                persona: resolved.name,
              }
            } else {
              // Manual mode
              for (const name of clientToolNames) {
                if (toolRegistry.has(name)) {
                  enabledToolNames.add(name)
                }
              }

              if (body.enabledTools === true) {
                for (const name of toolRegistry.names()) {
                  const tool = toolRegistry.get(name)
                  if (tool && !tool.client) {
                    enabledToolNames.add(name)
                  }
                }
              } else if (Array.isArray(body.enabledTools)) {
                for (const name of body.enabledTools) {
                  if (toolRegistry.has(name)) {
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

            // Build tool schemas
            const serverEnabledSchemas = Array.from(enabledToolNames)
              .map((name) => toolRegistry.get(name))
              .filter((t): t is IsomorphicTool => t !== undefined)
              .map(toToolSchema)

            const clientSchemas = body.isomorphicTools ?? []

            // Dedupe schemas
            const seenNames = new Set<string>()
            const toolSchemas: ToolSchema[] = []
            for (const schema of [...serverEnabledSchemas, ...clientSchemas]) {
              if (!seenNames.has(schema.name)) {
                seenNames.add(schema.name)
                toolSchemas.push(schema)
              }
            }

            if (isReconnect) {
              // RECONNECT PATH: Acquire existing session, stream from buffer at offset
              const session = yield* registry.acquire(sessionId)

              try {
                // Stream from buffer starting at lastLSN
                const pullStream = yield* createPullStream(session.buffer, startLSN)

                let result = yield* pullStream.next()
                while (!result.done) {
                  const frame = result.value as TokenFrame<string>
                  const durableEvent = { lsn: frame.lsn, event: JSON.parse(frame.token) }
                  controller.enqueue(encoder.encode(JSON.stringify(durableEvent) + '\n'))
                  result = yield* pullStream.next()
                }
              } finally {
                yield* registry.release(sessionId)
              }
            } else {
              // NEW SESSION PATH: Create engine, stream to buffer, then to response

              // Create the chat engine
              const engine = createChatEngine({
                messages: body.messages,
                ...(systemPrompt !== undefined && { systemPrompt }),
                toolSchemas: serverEnabledSchemas,
                toolRegistry,
                clientIsomorphicTools: clientSchemas,
                isomorphicClientOutputs: body.isomorphicClientOutputs ?? [],
                provider,
                maxIterations,
                signal: request.signal,
                ...(body.model !== undefined && { model: body.model }),
                sessionInfo,
              })

              // Wrap engine to serialize events
              const serializedStream = createSerializedEventStream(engine)

              // Acquire session with the engine as source
              // This spawns a writer task that pulls from engine and writes to buffer
              const session = yield* registry.acquire(sessionId, {
                source: serializedStream,
              })

              try {
                // Stream from buffer to response
                const pullStream = yield* createPullStream(session.buffer, 0)

                let result = yield* pullStream.next()
                while (!result.done) {
                  const frame = result.value as TokenFrame<string>
                  const durableEvent = { lsn: frame.lsn, event: JSON.parse(frame.token) }
                  controller.enqueue(encoder.encode(JSON.stringify(durableEvent) + '\n'))
                  result = yield* pullStream.next()
                }
              } finally {
                yield* registry.release(sessionId)
              }
            }
          })
        } catch (error) {
          // Emit error event
          const errorEvent = {
            lsn: 0,
            event: {
              type: 'error',
              message: error instanceof Error ? error.message : 'Unknown error',
              recoverable: false,
            },
          }
          controller.enqueue(encoder.encode(JSON.stringify(errorEvent) + '\n'))
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
        'X-Session-Id': sessionId,
      },
    })
  }
}
