/**
 * Core-Based MCP Tool Context
 *
 * Implements McpToolContext using @sweatpants/core's transport-based primitives.
 * This bridges the MCP tool API with core's elicit/sample/notify operations.
 *
 * ## Architecture
 *
 * The context uses TransportContext to route requests through a CorrelatedTransport:
 *
 * ```
 * Tool Code                       Transport              Host/UI
 * ─────────────────────────────────────────────────────────────────
 * ctx.sample({prompt})  ──►  transport.request() ──►  LLM handler
 *                       ◄──  progress/response   ◄──
 *
 * ctx.elicit('key', opts) ──► transport.request() ──► UI handler
 *                          ◄── progress/response ◄──
 *
 * ctx.notify(msg)         ──► transport.request() ──► notification
 * ```
 *
 * ## Key Differences from Signal-Based Context
 *
 * The original worker-runner used Effection signals for correlation.
 * This version uses core's CorrelatedTransport which:
 *
 * 1. Works over any transport (postMessage, WebSocket, etc.)
 * 2. Provides proper request/response correlation via message IDs
 * 3. Supports streaming progress updates
 * 4. Integrates with core's tool factory pattern
 *
 * @packageDocumentation
 */

import { type Operation, type Subscription } from 'effection'
import { TransportContext } from '@sweatpants/core'
import type { CorrelatedTransport, ElicitResponse, NotifyResponse } from '@sweatpants/core'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
  Message,
  LogLevel,
  McpToolContext,
  McpToolContextWithElicits,
  McpToolBranchOptions,
  ElicitConfig,
  ElicitResult,
  ElicitExchange,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleExchange,
  McpToolSampleConfig,
  SampleConfigPlainPrompt,
  SampleConfigPlainMessages,
  SampleConfigSchemaPrompt,
  SampleConfigSchemaMessages,
  SampleConfigToolsPrompt,
  SampleConfigToolsMessages,
  SampleToolsConfig,
  SampleToolsConfigMessages,
  SampleSchemaConfig,
  SampleSchemaConfigMessages,
  SampleToolsResult,
  SampleSchemaResult,
  ElicitsMap,
  ExtractElicitResponse,
  ExtractElicitContext,
  McpMessage,
} from '../mcp-tool-types.ts'
import {
  createRawSampleExchange,
  createStructuredSampleExchange,
  SampleValidationError,
} from '../mcp-tool-types.ts'
import {
  mapStatusToElicitAction,
} from './postmessage-transport.ts'

// =============================================================================
// ID GENERATION
// =============================================================================

let idCounter = 0

/**
 * Generate a unique request ID.
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`
}

// =============================================================================
// CORE-BASED CONTEXT FACTORY
// =============================================================================

/**
 * Options for creating a core-based MCP tool context.
 */
export interface CoreContextOptions {
  /** Tool name (for correlation IDs) */
  toolName: string
  /** Tool call ID */
  callId: string
  /** Parent messages (readonly) */
  parentMessages?: readonly Message[]
  /** Parent system prompt */
  parentSystemPrompt?: string
  /** Current branch depth */
  depth?: number
}

/**
 * Create a core-based McpToolContext.
 *
 * This context routes elicit/sample/notify through TransportContext,
 * enabling use with any transport implementation.
 *
 * @param options - Context configuration
 * @returns Operation that yields the context
 */
export function* createCoreContext(
  options: CoreContextOptions
): Operation<McpToolContext> {
  const transport = yield* TransportContext.expect()
  
  return createContextFromTransport(transport, options)
}

/**
 * Create a core-based McpToolContext with keyed elicitation.
 *
 * @param options - Context configuration
 * @param _elicitsMap - The elicits map (used for type inference, not at runtime)
 * @returns Operation that yields the context with keyed elicit
 */
export function* createCoreContextWithElicits<TElicits extends ElicitsMap>(
  options: CoreContextOptions,
  _elicitsMap: TElicits
): Operation<McpToolContextWithElicits<TElicits>> {
  const transport = yield* TransportContext.expect()
  
  return createContextWithElicitsFromTransport<TElicits>(transport, options, _elicitsMap)
}

// =============================================================================
// CONTEXT IMPLEMENTATION (from transport)
// =============================================================================

/**
 * Create a McpToolContext from a CorrelatedTransport directly.
 * 
 * This is the lower-level factory used by createCoreContext.
 * Useful when you already have a CorrelatedTransport reference.
 */
export function createContextFromTransport(
  transport: CorrelatedTransport,
  options: CoreContextOptions
): McpToolContext {
  const {
    toolName,
    callId,
    parentMessages = [],
    parentSystemPrompt,
    depth = 0,
  } = options

  // Mutable message history for this branch
  const messages: Message[] = []
  let elicitSeq = 0
  let sampleSeq = 0

  // ---------------------------------------------------------------------------
  // Sample Implementation
  // ---------------------------------------------------------------------------

  function* sampleImpl(config: McpToolSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls> {
    const sampleId = generateId(`${callId}:sample:${++sampleSeq}`)
    
    // Determine if using prompt or messages mode
    const usePrompt = 'prompt' in config && config.prompt !== undefined
    const promptText = usePrompt ? (config as SampleConfigPlainPrompt).prompt : ''
    const messagesToSend = usePrompt 
      ? [...messages, { role: 'user' as const, content: promptText }]
      : (config as SampleConfigPlainMessages).messages

    // Build request payload
    const payload: Record<string, unknown> = {
      messages: messagesToSend,
      maxTokens: config.maxTokens,
      systemPrompt: config.systemPrompt,
      modelPreferences: config.modelPreferences,
    }

    // Add schema if present (structured output)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configAny = config as any
    if (configAny.schema) {
      payload.schema = zodToJsonSchema(configAny.schema)
    }

    // Add tools if present
    if (configAny.tools) {
      payload.tools = configAny.tools.map((tool: { name: string; description?: string; inputSchema: unknown }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema instanceof Object && 'parse' in tool.inputSchema
          ? zodToJsonSchema(tool.inputSchema as never)
          : tool.inputSchema,
      }))
      payload.toolChoice = configAny.toolChoice ?? 'auto'
    }

    // Send request through transport
    const stream = transport.request<unknown, ElicitResponse>({
      id: sampleId,
      kind: 'elicit',
      type: 'sample',
      payload,
    })

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream

    // Consume progress updates (if any)
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }

    const response = result.value

    if (response.status !== 'accepted') {
      throw new Error(`Sample request failed: ${response.status}`)
    }

    // Parse response content
    const rawResult = response.content as {
      text: string
      model?: string
      stopReason?: string
      parsed?: unknown
      parseError?: { message: string; rawText: string }
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    }

    // Update messages if using prompt mode
    if (usePrompt) {
      messages.push({ role: 'user', content: promptText })
      messages.push({ role: 'assistant', content: rawResult.text })
    }

    // Build result based on what was requested
    if ('schema' in config && configAny.schema) {
      // Structured output result
      const toolCallId = generateId(`${callId}:schema`)
      const parsed = rawResult.parsed ?? null
      const exchange = parsed !== null
        ? createStructuredSampleExchange(promptText, parsed, toolCallId)
        : (createRawSampleExchange(promptText, rawResult.text) as unknown as SampleExchange<null>)

      return {
        text: rawResult.text,
        model: rawResult.model,
        stopReason: rawResult.stopReason,
        parsed,
        parseError: rawResult.parseError,
        exchange: {
          ...exchange,
          parsed,
        },
      } as SampleResultWithParsed<unknown>
    }

    if ('tools' in config && config['tools']) {
      // Tool calling result
      return {
        text: rawResult.text,
        model: rawResult.model,
        stopReason: rawResult.stopReason,
        toolCalls: rawResult.toolCalls ?? [],
        exchange: createRawSampleExchange(promptText, rawResult.text),
      } as SampleResultWithToolCalls
    }

    // Plain result
    return {
      text: rawResult.text,
      model: rawResult.model,
      stopReason: rawResult.stopReason,
      exchange: createRawSampleExchange(promptText, rawResult.text),
    } as SampleResultBase
  }

  // ---------------------------------------------------------------------------
  // Sample Helpers (sampleTools, sampleSchema)
  // ---------------------------------------------------------------------------

  function* sampleToolsImpl(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult> {
    const maxAttempts = (config.retries ?? 2) + 1
    let lastResult: SampleResultWithToolCalls | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = yield* sampleImpl({
        ...config,
        toolChoice: config.toolChoice ?? 'required',
      } as SampleConfigToolsPrompt | SampleConfigToolsMessages) as Operation<SampleResultWithToolCalls>

      lastResult = result

      if (result.stopReason === 'toolUse' && result.toolCalls.length > 0) {
        return result as SampleToolsResult
      }

      // Add retry hint for next attempt
      if (attempt < maxAttempts && 'prompt' in config) {
        config = {
          ...config,
          prompt: `${config.prompt}\n\nPlease call one of the available tools.`,
        }
      }
    }

    throw new SampleValidationError(
      'sampleTools',
      maxAttempts,
      lastResult!,
      `Model did not call any tools after ${maxAttempts} attempts`
    )
  }

  function* sampleSchemaImpl<T>(config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>> {
    const maxAttempts = (config.retries ?? 2) + 1
    let lastResult: SampleResultWithParsed<T> | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = yield* sampleImpl(config as SampleConfigSchemaPrompt | SampleConfigSchemaMessages) as Operation<SampleResultWithParsed<T>>

      lastResult = result

      if (result.parsed !== null) {
        return {
          text: result.text,
          model: result.model,
          stopReason: result.stopReason,
          parsed: result.parsed,
          exchange: result.exchange as SampleExchange<T>,
        } as SampleSchemaResult<T>
      }

      // Add retry hint for next attempt
      if (attempt < maxAttempts && 'prompt' in config) {
        const errorHint = result.parseError?.message ?? 'Invalid response format'
        config = {
          ...config,
          prompt: `${config.prompt}\n\nPrevious attempt failed: ${errorHint}. Please provide a valid response.`,
        }
      }
    }

    throw new SampleValidationError(
      'sampleSchema',
      maxAttempts,
      lastResult!,
      `Model did not return valid parsed output after ${maxAttempts} attempts`
    )
  }

  // ---------------------------------------------------------------------------
  // Elicit Implementation (simple/unkeyed)
  // ---------------------------------------------------------------------------

  function* elicitImpl<T>(config: ElicitConfig<T>): Operation<ElicitResult<unknown, T>> {
    const elicitId = generateId(`${callId}:elicit:${++elicitSeq}`)

    // Convert Zod schema to JSON Schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsonSchema = zodToJsonSchema(config.schema as any)

    // Send request through transport
    const stream = transport.request<unknown, ElicitResponse>({
      id: elicitId,
      kind: 'elicit',
      type: 'elicit',
      payload: {
        key: 'default',
        toolName,
        callId,
        seq: elicitSeq,
        message: config.message,
        schema: jsonSchema,
      },
    })

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream

    // Consume progress updates
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }

    const response = result.value
    const action = mapStatusToElicitAction(response.status)

    if (action === 'accept' && response.status === 'accepted') {
      const content = response.content as T
      const exchange = createElicitExchange(elicitId, 'default', config.message, {}, content)
      return { action: 'accept', content, exchange }
    }

    if (action === 'decline') {
      return { action: 'decline' }
    }

    return { action: 'cancel' }
  }

  // ---------------------------------------------------------------------------
  // Branch Implementation
  // ---------------------------------------------------------------------------

  function* branchImpl<T>(
    fn: (ctx: McpToolContext) => Operation<T>,
    branchOptions?: McpToolBranchOptions
  ): Operation<T> {
    // Create child context
    const inheritMessages = branchOptions?.inheritMessages ?? true
    const inheritSystemPrompt = branchOptions?.inheritSystemPrompt ?? true

    const childSystemPrompt = inheritSystemPrompt ? parentSystemPrompt : branchOptions?.systemPrompt
    const childOptions: CoreContextOptions = {
      toolName,
      callId: generateId(`${callId}:branch`),
      parentMessages: inheritMessages ? [...parentMessages, ...messages] : (branchOptions?.messages ?? []),
      depth: depth + 1,
    }
    if (childSystemPrompt !== undefined) {
      childOptions.parentSystemPrompt = childSystemPrompt
    }

    const childCtx = createContextFromTransport(transport, childOptions)
    return yield* fn(childCtx)
  }

  // ---------------------------------------------------------------------------
  // Log/Notify Implementation
  // ---------------------------------------------------------------------------

  function* logImpl(level: LogLevel, message: string): Operation<void> {
    const notifyId = generateId(`${callId}:log`)

    const stream = transport.request<unknown, NotifyResponse>({
      id: notifyId,
      kind: 'notify',
      type: 'log',
      payload: { level, message },
    })

    const subscription: Subscription<unknown, NotifyResponse> = yield* stream
    
    // Consume until done
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }
  }

  function* notifyImpl(message: string, progress?: number): Operation<void> {
    const notifyId = generateId(`${callId}:notify`)

    const stream = transport.request<unknown, NotifyResponse>({
      id: notifyId,
      kind: 'notify',
      type: 'progress',
      payload: { message, progress },
    })

    const subscription: Subscription<unknown, NotifyResponse> = yield* stream
    
    // Consume until done
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }
  }

  // ---------------------------------------------------------------------------
  // Build Context Object
  // ---------------------------------------------------------------------------

  const ctx: McpToolContext = {
    get parentMessages() {
      return parentMessages
    },
    get parentSystemPrompt() {
      return parentSystemPrompt
    },
    get messages() {
      return messages as readonly Message[]
    },
    get depth() {
      return depth
    },

    sample: sampleImpl as McpToolContext['sample'],
    sampleTools: sampleToolsImpl,
    sampleSchema: sampleSchemaImpl,
    elicit: elicitImpl,
    branch: branchImpl,
    log: logImpl,
    notify: notifyImpl,
  }

  return ctx
}

// =============================================================================
// KEYED ELICITATION CONTEXT
// =============================================================================

/**
 * Create a McpToolContextWithElicits from a CorrelatedTransport.
 */
export function createContextWithElicitsFromTransport<TElicits extends ElicitsMap>(
  transport: CorrelatedTransport,
  options: CoreContextOptions,
  elicitsMap: TElicits
): McpToolContextWithElicits<TElicits> {
  const {
    toolName,
    callId,
    parentMessages = [],
    parentSystemPrompt,
    depth = 0,
  } = options

  // Get the base context (without keyed elicit)
  const baseCtx = createContextFromTransport(transport, options)

  // Mutable state for keyed elicitation
  let elicitSeq = 0
  const messages: Message[] = []

  // Keyed elicit implementation
  function* keyedElicitImpl<K extends keyof TElicits & string>(
    key: K,
    opts: { message: string } & ExtractElicitContext<TElicits[K]>
  ): Operation<ElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>> {
    const elicitDef = elicitsMap[key]
    if (!elicitDef) {
      throw new Error(`Unknown elicit key: ${key}`)
    }

    const elicitId = generateId(`${callId}:elicit:${++elicitSeq}`)

    // Extract message from options, rest is context
    const { message, ...context } = opts

    // Get the response schema from the definition
    const responseSchema = elicitDef.response
    const jsonSchema = zodToJsonSchema(responseSchema)

    // If there's a context schema, include context in the payload
    const contextSchema = 'context' in elicitDef ? elicitDef.context : undefined
    const contextJsonSchema = contextSchema ? zodToJsonSchema(contextSchema) : undefined

    // Send request through transport
    const stream = transport.request<unknown, ElicitResponse>({
      id: elicitId,
      kind: 'elicit',
      type: 'elicit',
      payload: {
        key,
        toolName,
        callId,
        seq: elicitSeq,
        message,
        schema: jsonSchema,
        contextSchema: contextJsonSchema,
        context,
      },
    })

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream

    // Consume progress updates
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }

    const response = result.value
    const action = mapStatusToElicitAction(response.status)

    type TContext = ExtractElicitContext<TElicits[K]>
    type TResponse = ExtractElicitResponse<TElicits[K]>

    if (action === 'accept' && response.status === 'accepted') {
      const content = response.content as TResponse
      const exchange = createElicitExchange<TContext>(
        elicitId,
        key,
        message,
        context as TContext,
        content
      )
      return { action: 'accept', content, exchange }
    }

    if (action === 'decline') {
      return { action: 'decline' }
    }

    return { action: 'cancel' }
  }

  // Keyed branch implementation
  function* keyedBranchImpl<T>(
    fn: (ctx: McpToolContextWithElicits<TElicits>) => Operation<T>,
    branchOptions?: McpToolBranchOptions
  ): Operation<T> {
    const inheritMessages = branchOptions?.inheritMessages ?? true
    const inheritSystemPrompt = branchOptions?.inheritSystemPrompt ?? true

    const childSystemPrompt = inheritSystemPrompt ? parentSystemPrompt : branchOptions?.systemPrompt
    const childOptions: CoreContextOptions = {
      toolName,
      callId: generateId(`${callId}:branch`),
      parentMessages: inheritMessages ? [...parentMessages, ...messages] : (branchOptions?.messages ?? []),
      depth: depth + 1,
    }
    if (childSystemPrompt !== undefined) {
      childOptions.parentSystemPrompt = childSystemPrompt
    }

    const childCtx = createContextWithElicitsFromTransport<TElicits>(transport, childOptions, elicitsMap)
    return yield* fn(childCtx)
  }

  // Build the keyed context
  const keyedCtx: McpToolContextWithElicits<TElicits> = {
    get parentMessages() {
      return baseCtx.parentMessages
    },
    get parentSystemPrompt() {
      return baseCtx.parentSystemPrompt
    },
    get messages() {
      return baseCtx.messages
    },
    get depth() {
      return baseCtx.depth
    },

    sample: baseCtx.sample,
    sampleTools: baseCtx.sampleTools,
    sampleSchema: baseCtx.sampleSchema,
    elicit: keyedElicitImpl as McpToolContextWithElicits<TElicits>['elicit'],
    branch: keyedBranchImpl,
    log: baseCtx.log,
    notify: baseCtx.notify,
  }

  return keyedCtx
}

// =============================================================================
// EXCHANGE HELPERS
// =============================================================================

/**
 * Create an ElicitExchange for keyed elicitation.
 */
function createElicitExchange<TContext>(
  elicitId: string,
  key: string,
  _message: string,  // Reserved for future use in exchange metadata
  context: TContext,
  content: unknown
): ElicitExchange<TContext> {
  const toolUseId = `elicit_${elicitId}`

  // Request message (assistant with tool_use)
  const request: McpMessage & { role: 'assistant' } = {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolUseId,
      name: key,
      input: {}, // Safe default - no context exposed
    }],
  }

  // Response message (user with tool_result)
  const response: McpMessage & { role: 'user' } = {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId,
      content: [{ type: 'text', text: JSON.stringify(content) }],
    }],
  }

  return {
    context,
    request,
    response,
    messages: [request, response],
    withArguments(fn: (ctx: TContext) => Record<string, unknown>): [McpMessage, McpMessage] {
      const args = fn(context)
      const requestWithArgs: McpMessage & { role: 'assistant' } = {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: key,
          input: args,
        }],
      }
      return [requestWithArgs, response]
    },
  }
}
