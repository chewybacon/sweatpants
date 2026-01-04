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
import { useLogger } from '../../lib/logger'
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
    console.log('[durable-handler] handler called')
    // Parse request
    const body = (await request.json()) as ChatRequestBody
    console.log('[durable-handler] body parsed')
    const bindingSource = createBindingSource(request)
    const { sessionId: requestedSessionId, lastLSN } = durableParamsBinder(bindingSource)

    // Determine session ID
    const sessionId = requestedSessionId ?? crypto.randomUUID()
    const isReconnect = requestedSessionId !== undefined && lastLSN !== undefined
    const startLSN = lastLSN ?? 0
    console.log('[durable-handler] sessionId:', sessionId, 'isReconnect:', isReconnect)

    const encoder = new TextEncoder()

    // Create the streaming response
    console.log('[durable-handler] creating ReadableStream')
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        console.log('[durable-handler] ReadableStream.start() called')
        const [scope, destroy] = createScope()
        console.log('[durable-handler] scope created')

        const abortHandler = () => destroy()
        request.signal.addEventListener('abort', abortHandler)

        try {
          console.log('[durable-handler] running scope.run()')
          await scope.run(function* (): Operation<void> {
            console.log('[durable-handler] inside scope.run generator')
            // Run initializer hooks
            for (let i = 0; i < initializerHooks.length; i++) {
              console.log(`[durable-handler] running hook ${i + 1}/${initializerHooks.length}`)
              yield* initializerHooks[i]({ request, body })
              console.log(`[durable-handler] hook ${i + 1} completed`)
            }

            console.log('[durable-handler] all hooks completed')
            // Get logger after hooks run (so setupLogger has executed)
            const log = yield* useLogger('handler:durable')
            console.log('[durable-handler] logger acquired')
            log.debug({ sessionId, isReconnect, startLSN, messageCount: body.messages.length }, 'request received')

            // Get dependencies from contexts
            const provider = yield* ProviderContext.get()
            if (!provider) {
              throw new Error('Provider not configured. Ensure a provider initializer hook sets ProviderContext.')
            }
            log.debug('provider configured')

            const tools = yield* ToolRegistryContext.get()
            if (!tools) {
              throw new Error('Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.')
            }
            log.debug({ toolCount: tools.length }, 'tools configured')

            const resolvePersona = yield* PersonaResolverContext.get()
            const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations

            // Get session registry from durable streams context
            log.debug('getting session registry')
            const registry: SessionRegistry<string> = yield* useSessionRegistry<string>()
            log.debug('session registry acquired')

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
              log.debug({ sessionId, startLSN }, 'reconnect path: acquiring existing session')
              const session = yield* registry.acquire(sessionId)
              log.debug({ sessionId }, 'reconnect path: session acquired')

              try {
                // Stream from buffer starting at lastLSN
                log.debug({ sessionId, startLSN }, 'reconnect path: creating pull stream')
                const pullStream = yield* createPullStream(session.buffer, startLSN)
                log.debug({ sessionId }, 'reconnect path: pull stream created, starting read loop')

                let eventCount = 0
                let result = yield* pullStream.next()
                while (!result.done) {
                  const frame = result.value as TokenFrame<string>
                  const durableEvent = { lsn: frame.lsn, event: JSON.parse(frame.token) }
                  controller.enqueue(encoder.encode(JSON.stringify(durableEvent) + '\n'))
                  eventCount++
                  if (eventCount % 50 === 0) {
                    log.debug({ sessionId, eventCount, lsn: frame.lsn }, 'reconnect path: streaming progress')
                  }
                  result = yield* pullStream.next()
                }
                log.debug({ sessionId, totalEvents: eventCount }, 'reconnect path: stream complete')
              } finally {
                log.debug({ sessionId }, 'reconnect path: releasing session')
                yield* registry.release(sessionId)
              }
            } else {
              // NEW SESSION PATH: Create engine, stream to buffer, then to response
              log.debug({ sessionId }, 'new session path: creating chat engine')

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
              log.debug({ sessionId }, 'new session path: chat engine created')

              // Wrap engine to serialize events
              const serializedStream = createSerializedEventStream(engine)
              log.debug({ sessionId }, 'new session path: serialized stream created')

              // Acquire session with the engine as source
              // This spawns a writer task that pulls from engine and writes to buffer
              log.debug({ sessionId }, 'new session path: acquiring session with source')
              const session = yield* registry.acquire(sessionId, {
                source: serializedStream,
              })
              log.debug({ sessionId }, 'new session path: session acquired')

              try {
                // Stream from buffer to response
                log.debug({ sessionId }, 'new session path: creating pull stream')
                const pullStream = yield* createPullStream(session.buffer, 0)
                log.debug({ sessionId }, 'new session path: pull stream created, starting read loop')

                let eventCount = 0
                let result = yield* pullStream.next()
                log.debug({ sessionId }, 'new session path: first pullStream.next() returned')
                while (!result.done) {
                  const frame = result.value as TokenFrame<string>
                  const durableEvent = { lsn: frame.lsn, event: JSON.parse(frame.token) }
                  controller.enqueue(encoder.encode(JSON.stringify(durableEvent) + '\n'))
                  eventCount++
                  if (eventCount % 50 === 0) {
                    log.debug({ sessionId, eventCount, lsn: frame.lsn }, 'new session path: streaming progress')
                  }
                  result = yield* pullStream.next()
                }
                log.debug({ sessionId, totalEvents: eventCount }, 'new session path: stream complete')
              } finally {
                log.debug({ sessionId }, 'new session path: releasing session')
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

    console.log('[durable-handler] creating Response')
    const response = new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Session-Id': sessionId,
      },
    })
    console.log('[durable-handler] Response created, returning')
    return response
  }
}
