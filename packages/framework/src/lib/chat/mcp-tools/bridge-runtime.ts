/**
 * Bridge Runtime for In-App MCP Tool Execution
 *
 * Enables running MCP tools inside the framework (not via external MCP server).
 * When a tool calls `ctx.elicit(key, {message})`, the runtime:
 * 1. Emits an ElicitRequest to the output channel
 * 2. Suspends waiting for a response via Signal
 * 3. Validates the response with Zod and resumes the generator
 *
 * This enables UI-driven elicitation where the client renders a component
 * and sends back the user's response.
 *
 * ## Buffered Channel Pattern
 *
 * The bridge uses a buffered channel for events. This means:
 * - Events are queued until a subscriber is ready
 * - No messages are dropped, even if subscriber connects late
 * - No sleep(0) hacks needed
 *
 * @packageDocumentation
 */
import { type Operation, type Channel, type Signal, createChannel, createSignal, spawn, each, call } from 'effection'
import { z } from 'zod'
import { encodeElicitContext } from '@sweatpants/elicit-context'
import type {
  McpToolContextWithElicits,
  McpToolHandoffConfigWithElicits,
  McpToolLimits,
  McpToolBranchOptions,
  McpToolSampleConfig,
  McpToolServerContext,
  ElicitId,
  ElicitRequest,
  ElicitsMap,
  Message,
  SampleResult,
  ElicitResult,
  LogLevel,
} from './mcp-tool-types'
import {
  McpToolDepthError,
  McpToolTokenError,
} from './mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from './mcp-tool-builder'

// Legacy type aliases for backward compatibility
type BranchContextWithElicits<T extends ElicitsMap> = McpToolContextWithElicits<T>
type BranchHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits extends ElicitsMap> = 
  McpToolHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>
type BranchLimits = McpToolLimits
type BranchOptions = McpToolBranchOptions
type BranchSampleConfig = McpToolSampleConfig
type BranchServerContext = McpToolServerContext
const BranchDepthError = McpToolDepthError
const BranchTokenError = McpToolTokenError
type FinalizedBranchToolWithElicits<TName extends string, TParams, THandoff, TClient, TResult, TElicits extends ElicitsMap> = 
  FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>

// =============================================================================
// BUFFERED CHANNEL (Queue-based, never drops messages)
// =============================================================================

/**
 * Create a sync-safe buffered channel that won't drop messages.
 *
 * Unlike useBufferedChannel (which is a resource), this returns a Channel
 * that can be created synchronously. Messages are queued until a subscriber
 * starts iterating, then forwarded in order.
 *
 * This is used by createBridgeHost where we need to create the channel
 * synchronously but don't want to drop messages.
 */
function createBufferedChannel<T>(): Channel<T, void> {
  // Queue for buffering messages until subscriber is ready
  const queue: T[] = []
  let closed = false
  let hasSubscriber = false

  // Callbacks for async coordination
  let subscriberResolve: (() => void) | null = null
  let itemResolve: (() => void) | null = null
  let closeResolve: (() => void) | null = null

  // The underlying channel for actual pub/sub (created lazily)
  let channel: Channel<T, void> | null = null
  let forwarderStarted = false

  return {
    *send(message: T) {
      if (closed) return
      queue.push(message)
      if (itemResolve) {
        itemResolve()
        itemResolve = null
      }
    },

    *close() {
      closed = true
      if (itemResolve) {
        itemResolve()
        itemResolve = null
      }

      // If queue is empty and no subscriber, just return
      if (queue.length === 0 && !hasSubscriber) {
        return
      }

      // If there are queued messages but no subscriber yet,
      // wait for subscriber to start processing
      if (!hasSubscriber && queue.length > 0) {
        yield* call(
          () =>
            new Promise<void>(resolve => {
              subscriberResolve = resolve
            })
        )
      }

      // Wait for forwarder to finish delivering all messages
      yield* call(
        () =>
          new Promise<void>(resolve => {
            if (queue.length === 0 && forwarderStarted) {
              resolve()
            } else {
              closeResolve = resolve
            }
          })
      )

      if (channel) {
        yield* channel.close()
      }
    },

    [Symbol.iterator]: function* () {
      hasSubscriber = true
      if (subscriberResolve) {
        subscriberResolve()
        subscriberResolve = null
      }

      // Create the underlying channel now
      channel = createChannel<T, void>()

      // Spawn forwarder that reads from queue and forwards to channel
      yield* spawn(function* () {
        forwarderStarted = true

        while (true) {
          // Process all queued items
          while (queue.length > 0) {
            const item = queue.shift()!
            yield* channel!.send(item)
          }

          // If closed and queue empty, close channel and exit
          if (closed && queue.length === 0) {
            if (closeResolve) closeResolve()
            break
          }

          // Wait for more items or close
          yield* call(function waitForItem(): Promise<void> {
            if (queue.length > 0 || closed) return Promise.resolve()
            return new Promise(resolve => {
              itemResolve = resolve
            })
          })
        }
      })

      // Return the channel's subscription
      return yield* channel
    },
  }
}

// =============================================================================
// BRIDGE HOST INTERFACE
// =============================================================================

/**
 * Elicitation response from the client.
 */
export interface ElicitResponse<T = unknown> {
  /** Matches the request id */
  id: ElicitId

  /** The user's response */
  result: ElicitResult<T>
}

/**
 * Sample response from external handler.
 */
export interface SampleResponse {
  result: SampleResult
}

/**
 * Events emitted by the bridge runtime.
 */
export type BridgeEvent =
  | { type: 'elicit'; request: ElicitRequest; responseSignal: Signal<ElicitResponse, void> }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'notify'; message: string; progress?: number }
  | { type: 'sample'; messages: Message[]; options?: { systemPrompt?: string; maxTokens?: number }; responseSignal: Signal<SampleResponse, void> }

/**
 * Sampling provider for the bridge runtime.
 *
 * Implements the LLM sampling backchannel. This is server-side,
 * so it uses the framework's configured provider.
 */
export interface BridgeSamplingProvider {
  sample(
    messages: Message[],
    options?: { systemPrompt?: string; maxTokens?: number }
  ): Operation<SampleResult>
}

/**
 * Bridge host configuration.
 * 
 * Note: samplingProvider is no longer part of this config.
 * Sampling is now handled via the responseSignal pattern - the event handler
 * (tool-session or runBridgeTool) is responsible for calling the sampling
 * provider and sending the response via the signal.
 */
export interface BridgeHostConfig<
  TName extends string = string,
  TParams = unknown,
  THandoff = unknown,
  TClient = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
> {
  /** Tool being executed */
  tool: FinalizedBranchToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>

  /** Tool parameters */
  params: TParams

  /** Abort signal for cancellation */
  signal?: AbortSignal

  /** Tool call ID (generated if not provided) */
  callId?: string

  /** Override limits from tool definition */
  limits?: BranchLimits

  /** Initial messages (parent context) */
  parentMessages?: Message[]

  /** Initial system prompt */
  systemPrompt?: string
}

/**
 * Bridge host handle returned from createBridgeHost().
 *
 * The host runs the tool and manages the elicitation channel.
 */
export interface BridgeHost<TResult> {
  /**
   * Channel for receiving events (elicit requests, logs, etc.)
   * Client code should subscribe to this and handle events.
   */
  events: Channel<BridgeEvent, void>

  /**
   * Run the tool to completion.
   * Returns when the tool finishes (either successfully or with error).
   */
  run(): Operation<TResult>
}

// =============================================================================
// TOKEN TRACKING
// =============================================================================

interface TokenTracker {
  used: number
  budget?: number
  parent?: TokenTracker
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateTokensFromConversation(options: {
  systemPrompt?: string
  messages: Message[]
  completion: string
}): number {
  const system = options.systemPrompt ? estimateTokensFromText(options.systemPrompt) : 0
  const convo = options.messages.reduce((sum, msg) => sum + estimateTokensFromText(msg.content), 0)
  const completion = estimateTokensFromText(options.completion)
  return system + convo + completion
}

function addTokens(tracker: TokenTracker, tokens: number): void {
  for (let current: TokenTracker | undefined = tracker; current; current = current.parent) {
    current.used += tokens
    if (current.budget !== undefined && current.used > current.budget) {
      throw new BranchTokenError(current.used, current.budget)
    }
  }
}

// =============================================================================
// BRANCH STATE
// =============================================================================

interface BranchState<TElicits extends ElicitsMap> {
  messages: Message[]
  systemPrompt?: string
  parentMessages: readonly Message[]
  parentSystemPrompt?: string
  depth: number
  limits: BranchLimits
  tokenTracker: TokenTracker

  // Bridge-specific state
  toolName: string
  callId: string
  elicitSeq: number
  elicits: TElicits
  eventChannel: Channel<BridgeEvent, void>
  // Note: samplingProvider removed - sampling now uses responseSignal pattern
  // The event handler (tool-session or runBridgeTool) is responsible for
  // calling the sampling provider and sending the response via the signal
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Error thrown when elicit() is called inside a sub-branch.
 * Elicitation is only allowed at depth 0 (root branch).
 */
export class BranchElicitNotAllowedError extends Error {
  constructor(public readonly depth: number) {
    super(`elicit() is not allowed inside sub-branches (depth=${depth}). Elicitation must happen at the root branch.`)
    this.name = 'BranchElicitNotAllowedError'
  }
}

// =============================================================================
// HELPER: CONVERT ZOD TO JSON SCHEMA (INLINE)
// =============================================================================

/**
 * Convert Zod schema to JSON Schema for MCP elicitation.
 * Uses Zod's built-in toJSONSchema() method.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}

// =============================================================================
// CONTEXT IMPLEMENTATION
// =============================================================================

function createBridgeContext<TElicits extends ElicitsMap>(
  state: BranchState<TElicits>
): BranchContextWithElicits<TElicits> {
  return {
    // Read-only parent context
    get parentMessages() {
      return state.parentMessages
    },
    get parentSystemPrompt() {
      return state.parentSystemPrompt
    },

    // Current branch state
    get messages() {
      return state.messages as readonly Message[]
    },
    get depth() {
      return state.depth
    },

    // LLM backchannel
    sample(config: BranchSampleConfig): Operation<SampleResult> {
      return {
        *[Symbol.iterator]() {
          let messages: Message[]

          if ('prompt' in config && config.prompt) {
            const userMessage: Message = { role: 'user', content: config.prompt }
            messages = [...state.messages, userMessage]
          } else if ('messages' in config && config.messages) {
            messages = config.messages
          } else {
            throw new Error('sample() requires either prompt or messages')
          }

          const sampleOptions: { systemPrompt?: string; maxTokens?: number } = {}
          const effectiveSystemPrompt = config.systemPrompt ?? state.systemPrompt
          if (effectiveSystemPrompt !== undefined) {
            sampleOptions.systemPrompt = effectiveSystemPrompt
          }
          if (config.maxTokens !== undefined) {
            sampleOptions.maxTokens = config.maxTokens
          }

          // Create a signal for the response
          const responseSignal = createSignal<SampleResponse, void>()

          // Emit sample event with response signal
          const event: BridgeEvent = {
            type: 'sample',
            messages,
            responseSignal,
          }
          if (Object.keys(sampleOptions).length > 0) {
            (event as Extract<BridgeEvent, { type: 'sample' }>).options = sampleOptions
          }
          yield* state.eventChannel.send(event)

          // Wait for response via signal
          // The listener (tool-session) will either:
          // 1. Call samplingProvider directly and send response, OR
          // 2. Forward to external MCP client and send response when received
          const subscription = yield* responseSignal
          const next = yield* subscription.next()
          if (next.done) {
            throw new Error('Sample signal closed without response')
          }
          const result = next.value.result

          // If using auto-tracked mode, update branch messages
          if ('prompt' in config && config.prompt) {
            state.messages.push(
              { role: 'user', content: config.prompt },
              { role: 'assistant', content: result.text }
            )
          }

          // Track token usage
          const estimatedTokens = estimateTokensFromConversation({
            ...(sampleOptions.systemPrompt !== undefined
              ? { systemPrompt: sampleOptions.systemPrompt }
              : {}),
            messages,
            completion: result.text,
          })
          addTokens(state.tokenTracker, estimatedTokens)

          return result
        },
      }
    },

    // User backchannel - KEYED elicitation
    elicit<K extends keyof TElicits & string>(
      key: K,
      options: any // Will be properly typed by McpToolContextWithElicits interface
    ): Operation<any> {
      return {
        *[Symbol.iterator]() {
          // Phase 5: Disallow elicit in sub-branches
          if (state.depth > 0) {
            throw new BranchElicitNotAllowedError(state.depth)
          }

          // Get the elicit definition for this key
          const definition = state.elicits[key]
          if (!definition) {
            throw new Error(`Unknown elicitation key "${key}" for tool "${state.toolName}"`)
          }

          // Extract response schema from definition
          const responseSchema = definition.response

          // Increment sequence for this call
          const seq = state.elicitSeq++

          // Build the structured ID
          const id: ElicitId = {
            toolName: state.toolName,
            key,
            callId: state.callId,
            seq,
          }

          // Extract message and context data
          const { message, ...contextData } = options

          // Encode context into schema and message using x-elicit-context transport
          const baseSchema = zodToJsonSchema(responseSchema as any)
          const { message: encodedMessage, schema: encodedSchema } = encodeElicitContext(
            message,
            contextData,
            baseSchema
          )

          // Build the request
          const request: ElicitRequest<K, any> = {
            id,
            key,
            toolName: state.toolName,
            callId: state.callId,
            seq,
            message: encodedMessage,
            schema: {
              zod: responseSchema,
              json: encodedSchema,
            },
          }

          // Create a signal for the response
          const responseSignal = createSignal<ElicitResponse, void>()

          // Emit the elicit event with the signal
          yield* state.eventChannel.send({ type: 'elicit', request, responseSignal })

          // Wait for response via signal
          const subscription = yield* responseSignal
          const next = yield* subscription.next()
          if (next.done) {
            throw new Error(`Elicit signal closed without response for key "${key}"`)
          }
          const response = next.value

          // Validate the response matches our request
          if (
            response.id.toolName !== id.toolName ||
            response.id.key !== id.key ||
            response.id.callId !== id.callId ||
            response.id.seq !== id.seq
          ) {
            throw new Error(
              `Elicit response mismatch: expected ${JSON.stringify(id)}, got ${JSON.stringify(response.id)}`
            )
          }

          // If accepted, validate content with Zod (use response schema)
          if (response.result.action === 'accept') {
            const parseResult = responseSchema.safeParse(response.result.content)
            if (!parseResult.success) {
              throw new Error(
                `Elicit response validation failed for key "${key}": ${parseResult.error.message}`
              )
            }
            return { action: 'accept', content: parseResult.data }
          }

          return response.result
        },
      }
    },

    // Sub-branches - inherit keyed elicitation
    branch<T>(
      fn: (ctx: BranchContextWithElicits<TElicits>) => Operation<T>,
      options: BranchOptions = {}
    ): Operation<T> {
      return {
        *[Symbol.iterator]() {
          const newDepth = state.depth + 1
          const maxDepth = options.maxDepth ?? state.limits.maxDepth

          if (maxDepth !== undefined && newDepth > maxDepth) {
            throw new BranchDepthError(newDepth, maxDepth)
          }

          const inheritMessages = options.inheritMessages ?? true
          const inheritSystemPrompt = options.inheritSystemPrompt ?? true

          let newMessages: Message[] = []
          if (inheritMessages) {
            newMessages = [...state.messages]
          }
          if (options.messages) {
            newMessages = [...newMessages, ...options.messages]
          }

          const newLimits: BranchLimits = {}
          if (options.maxDepth !== undefined) {
            newLimits.maxDepth = options.maxDepth
          } else if (state.limits.maxDepth !== undefined) {
            newLimits.maxDepth = state.limits.maxDepth
          }
          if (options.maxTokens !== undefined) {
            newLimits.maxTokens = options.maxTokens
          } else if (state.limits.maxTokens !== undefined) {
            newLimits.maxTokens = state.limits.maxTokens
          }
          if (options.timeout !== undefined) {
            newLimits.timeout = options.timeout
          } else if (state.limits.timeout !== undefined) {
            newLimits.timeout = state.limits.timeout
          }

          const subTokenTracker: TokenTracker = {
            used: 0,
            parent: state.tokenTracker,
          }
          if (newLimits.maxTokens !== undefined) {
            subTokenTracker.budget = newLimits.maxTokens
          }

          const newState: BranchState<TElicits> = {
            messages: newMessages,
            parentMessages: state.messages as readonly Message[],
            depth: newDepth,
            limits: newLimits,
            tokenTracker: subTokenTracker,
            // Bridge state is shared (same tool call)
            toolName: state.toolName,
            callId: state.callId,
            elicitSeq: state.elicitSeq, // Note: sub-branches share seq with parent
            elicits: state.elicits,
            eventChannel: state.eventChannel,
          }

          const newSystemPrompt = options.systemPrompt ?? (inheritSystemPrompt ? state.systemPrompt : undefined)
          if (newSystemPrompt !== undefined) {
            newState.systemPrompt = newSystemPrompt
          }
          if (state.systemPrompt !== undefined) {
            newState.parentSystemPrompt = state.systemPrompt
          }

          const subContext = createBridgeContext(newState)
          const result = yield* fn(subContext)

          // Update parent's elicitSeq from sub-branch (in case sub-branch advanced it)
          // Note: This is a no-op since elicit throws in sub-branches, but defensive
          state.elicitSeq = newState.elicitSeq

          return result
        },
      }
    },

    // Logging
    log(level: LogLevel, message: string): Operation<void> {
      return state.eventChannel.send({ type: 'log', level, message })
    },

    notify(message: string, progress?: number): Operation<void> {
      // Only include progress if defined
      const event: BridgeEvent = { type: 'notify', message }
      if (progress !== undefined) {
        (event as Extract<BridgeEvent, { type: 'notify' }>).progress = progress
      }
      return state.eventChannel.send(event)
    },
  }
}

// =============================================================================
// BRIDGE HOST IMPLEMENTATION
// =============================================================================

/**
 * Create a bridge host for running an MCP tool in-app.
 *
 * The host manages the tool's execution and provides channels for
 * elicitation and events.
 *
 * @example
 * ```typescript
 * const host = createBridgeHost({
 *   tool: bookFlightTool,
 *   params: { destination: 'NYC' },
 *   samplingProvider: myProvider,
 * })
 *
 * // Subscribe to events in parallel
 * yield* spawn(function* () {
 *   for (const event of yield* each(host.events)) {
 *     if (event.type === 'elicit') {
 *       // Render UI for elicitation
 *       const userResponse = yield* showUI(event.request)
 *       // Send response via the signal included in the event
 *       event.responseSignal.send({ id: event.request.id, result: userResponse })
 *     }
 *     yield* each.next()
 *   }
 * })
 *
 * // Run the tool
 * const result = yield* host.run()
 * ```
 */
export function createBridgeHost<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(
  config: BridgeHostConfig<TName, TParams, THandoff, TClient, TResult, TElicits>
): BridgeHost<TResult> {
  // Use a buffered channel to avoid subscribe-before-send race condition.
  // Messages are queued until a subscriber starts iterating.
  const eventChannel = createBufferedChannel<BridgeEvent>()

  const callId = config.callId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`

  return {
    events: eventChannel,

    run(): Operation<TResult> {
      return {
        *[Symbol.iterator]() {
          const { tool, params, limits: overrideLimits, parentMessages, systemPrompt } = config
          const signal = config.signal ?? new AbortController().signal

          // Validate params
          const parseResult = tool.parameters.safeParse(params)
          if (!parseResult.success) {
            throw new Error(`Invalid params for tool "${tool.name}": ${parseResult.error.message}`)
          }
          const validatedParams = parseResult.data as TParams

          // Merge limits
          const limits: BranchLimits = {
            ...tool.limits,
            ...overrideLimits,
          }

          // Create server context
          const serverCtx: BranchServerContext = {
            callId,
            signal,
          }

          const rootTokenTracker: TokenTracker = { used: 0 }
          if (limits.maxTokens !== undefined) {
            rootTokenTracker.budget = limits.maxTokens
          }

          // Create initial branch state
          const initialState: BranchState<TElicits> = {
            messages: [],
            parentMessages: parentMessages ?? [],
            depth: 0,
            limits,
            tokenTracker: rootTokenTracker,
            // Bridge state
            toolName: tool.name,
            callId,
            elicitSeq: 0,
            elicits: tool.elicits,
            eventChannel,
          }

          if (systemPrompt !== undefined) {
            initialState.systemPrompt = systemPrompt
            initialState.parentSystemPrompt = systemPrompt
          }

          let result: TResult

          if (tool.handoffConfig) {
            const handoffConfig = tool.handoffConfig as BranchHandoffConfigWithElicits<
              TParams,
              THandoff,
              TClient,
              TResult,
              TElicits
            >

            // Phase 1: before()
            const handoff = yield* handoffConfig.before(validatedParams, serverCtx)

            // Create context for client phase
            const branchCtx = createBridgeContext(initialState)

            // Client phase
            const clientResult = yield* handoffConfig.client(handoff, branchCtx)

            // Phase 2: after()
            result = yield* handoffConfig.after(handoff, clientResult, serverCtx, validatedParams)
          } else if (tool.execute) {
            const branchCtx = createBridgeContext(initialState)
            result = yield* tool.execute(validatedParams, branchCtx)
          } else {
            throw new Error(`Tool "${tool.name}" has no execute or handoff config`)
          }

          // Close channel when done
          yield* eventChannel.close()

          return result
        },
      }
    },
  }
}

// =============================================================================
// CONVENIENCE: RUN WITH AUTO-HANDLER
// =============================================================================

/**
 * Handler map for elicitation requests.
 * Each key maps to a generator that handles that elicitation.
 */
export type BridgeElicitHandlers<TElicits extends ElicitsMap> = {
  [K in keyof TElicits]: (
    request: ElicitRequest<K & string, any>
  ) => Operation<ElicitResult<any>>
}

/**
 * Run a bridgeable tool with handlers for elicitation.
 *
 * This is a convenience wrapper that wires up the event loop.
 * For more control, use createBridgeHost() directly.
 *
 * @example
 * ```typescript
 * const result = yield* runBridgeTool({
 *   tool: bookFlightTool,
 *   params: { destination: 'NYC' },
 *   samplingProvider: myProvider,
 *   handlers: {
 *     pickFlight: function* (req) {
 *       // Show UI, get user response
 *       return { action: 'accept', content: { flightId: 'FL123' } }
 *     },
 *     confirm: function* (req) {
 *       return { action: 'accept', content: { ok: true } }
 *     },
 *   },
 * })
 * ```
 */
export function runBridgeTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(config: {
  tool: FinalizedBranchToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>
  params: TParams
  samplingProvider: BridgeSamplingProvider
  handlers: BridgeElicitHandlers<TElicits>
  signal?: AbortSignal
  callId?: string
  limits?: BranchLimits
  parentMessages?: Message[]
  systemPrompt?: string
  onLog?: (level: LogLevel, message: string) => void
  onNotify?: (message: string, progress?: number) => void
  onSample?: (messages: Message[], options?: { systemPrompt?: string; maxTokens?: number }) => void
}): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      // createBridgeHost now uses a buffered channel internally,
      // so no sleep(0) hacks are needed. Events are queued until subscriber is ready.
      const hostConfig: BridgeHostConfig<TName, TParams, THandoff, TClient, TResult, TElicits> = {
        tool: config.tool,
        params: config.params,
      }

      // Only add optional properties if defined
      if (config.signal !== undefined) {
        hostConfig.signal = config.signal
      }
      if (config.callId !== undefined) {
        hostConfig.callId = config.callId
      }
      if (config.limits !== undefined) {
        hostConfig.limits = config.limits
      }
      if (config.parentMessages !== undefined) {
        hostConfig.parentMessages = config.parentMessages
      }
      if (config.systemPrompt !== undefined) {
        hostConfig.systemPrompt = config.systemPrompt
      }

      const host = createBridgeHost(hostConfig)

      // Spawn event handler
      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          switch (event.type) {
            case 'elicit': {
              const handler = config.handlers[event.request.key as keyof TElicits]
              if (!handler) {
                throw new Error(`No handler for elicitation key "${event.request.key}"`)
              }
              const result = yield* handler(event.request as any)
              event.responseSignal.send({ id: event.request.id, result })
              break
            }
            case 'log':
              config.onLog?.(event.level, event.message)
              break
            case 'notify':
              config.onNotify?.(event.message, event.progress)
              break
            case 'sample': {
              // Call the observability callback
              config.onSample?.(event.messages, event.options)
              // Call the sampling provider and send response back to bridge
              const sampleResult = yield* config.samplingProvider.sample(event.messages, event.options)
              event.responseSignal.send({ result: sampleResult })
              break
            }
          }
          yield* each.next()
        }
      })

      // No sleep(0) needed! The buffered channel queues events until subscriber iterates.
      const result = yield* host.run()

      return result
    },
  }
}
