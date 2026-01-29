/**
 * Worker Runner (Core-Based)
 *
 * This module runs inside a worker thread and executes tool generators.
 * It uses @sweatpants/core's transport interface with a signal-based
 * implementation for request/response correlation.
 *
 * ## Architecture
 *
 * See `docs/adr-signal-based-transport.md` for the full design rationale.
 *
 * The worker-runner creates a `CorrelatedTransport` backed by Effection signals
 * instead of using core's `createCorrelation`. This handles the worker scenario
 * where responses can take arbitrarily long (user closes tab, returns later).
 *
 * ## Full MCP Feature Support
 *
 * This implementation provides full MCP sampling capabilities:
 * - `prompt` or `messages` input modes
 * - `ExtendedMessage` support (tool_use, tool_result content blocks)
 * - `schema` for structured output with parsing
 * - `tools` + `toolChoice` for tool calling
 * - `sampleTools()` helper with retry logic
 * - `sampleSchema()` helper with retry logic
 *
 * See `docs/mcp-core-full-parity-plan.md` for the implementation plan.
 *
 * @packageDocumentation
 */

import { run, type Operation, type Subscription } from 'effection'
import { z } from 'zod'
import { TransportContext } from '@sweatpants/core'
import type { ElicitResponse, CorrelatedTransport } from '@sweatpants/core'
import type {
  WorkerTransport,
  StartMessage,
  WorkerToolRegistry,
  WorkerToolContext,
  WorkerSampleConfig,
  WorkerSampleConfigPlainPrompt,
  WorkerSampleConfigPlainMessages,
  WorkerSampleConfigSchemaPrompt,
  WorkerSampleConfigSchemaMessages,
  WorkerSampleConfigToolsPrompt,
  WorkerSampleConfigToolsMessages,
  WorkerSampleToolsConfig,
  WorkerSampleToolsConfigMessages,
  WorkerSampleSchemaConfig,
  WorkerSampleSchemaConfigMessages,
  ExtendedMessage,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
  SamplingToolDefinition,
} from './worker-types.ts'
import type {
  LogLevel,
  ElicitResult,
  McpMessage,
  SampleExchange,
} from '../mcp-tool-types.ts'
import {
  createRawSampleExchange,
  createStructuredSampleExchange,
  SampleValidationError,
} from '../mcp-tool-types.ts'
import { createSignalCorrelatedTransport } from './signal-correlated-transport.ts'

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool session worker using core's transport interface.
 *
 * This is the entry point for the worker thread. It:
 * 1. Sends 'ready' to indicate it's listening
 * 2. Waits for 'start' message
 * 3. Creates signal-based correlated transport
 * 4. Executes the tool with transport-backed context
 * 5. Sends result/error when done
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 */
export function runWorkerCore(transport: WorkerTransport, registry: WorkerToolRegistry): void {
  // Signal indicates we're ready
  transport.send({ type: 'ready' })

  // Wait for start message
  const unsubscribe = transport.subscribe(async (message) => {
    if (message.type === 'start') {
      unsubscribe()
      await executeToolWithCore(transport, registry, message)
    }
  })
}

/**
 * Execute a tool using core's transport infrastructure.
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 * @param startMessage - The start message with tool name and params
 */
async function executeToolWithCore(
  transport: WorkerTransport,
  registry: WorkerToolRegistry,
  startMessage: StartMessage
): Promise<void> {
  const { toolName, params, sessionId } = startMessage

  // Look up tool
  const tool = registry.get(toolName)
  if (!tool) {
    transport.send({
      type: 'error',
      name: 'ToolNotFound',
      message: `Tool not found: ${toolName}`,
      lsn: 1,
    })
    return
  }

  // Run the tool in an Effection scope with signal-based transport
  await run(function* () {
    let lsn = 0
    const nextLsn = () => ++lsn

    // Create signal-based correlated transport
    // This implements CorrelatedTransport using signals for correlation
    const correlatedTransport = yield* createSignalCorrelatedTransport(transport)

    // Set up transport context so operations can access it
    yield* TransportContext.set(correlatedTransport)

    // Create tool context using the correlated transport
    const ctx = createWorkerContextFromTransport(
      correlatedTransport,
      sessionId,
      nextLsn,
      transport
    )

    // Execute the tool
    try {
      const result = yield* tool.handler(params, ctx) as Operation<unknown>

      transport.send({
        type: 'result',
        result,
        lsn: nextLsn(),
      })
    } catch (error) {
      const err = error as Error
      transport.send({
        type: 'error',
        name: err.name,
        message: err.message,
        ...(err.stack !== undefined && { stack: err.stack }),
        lsn: nextLsn(),
      })
    }
  })
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert a Zod schema to JSON Schema.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}

/**
 * Generate a unique ID for internal use.
 */
function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Extract prompt text from config for exchange building.
 */
function getPromptText(config: WorkerSampleConfig): string {
  if ('prompt' in config && config.prompt !== undefined) {
    return config.prompt
  }
  // For messages mode, try to find the last user message
  if ('messages' in config && config.messages !== undefined) {
    const lastUserMsg = [...config.messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      return lastUserMsg.content
    }
  }
  return ''
}

/**
 * Convert config messages to ExtendedMessage array.
 * Handles both prompt mode (creates user message) and messages mode.
 */
function getMessages(config: WorkerSampleConfig): ExtendedMessage[] {
  if ('prompt' in config && config.prompt !== undefined) {
    return [{ role: 'user' as const, content: config.prompt }]
  }
  if ('messages' in config && config.messages !== undefined) {
    return config.messages
  }
  return []
}

// =============================================================================
// CONTEXT CREATION
// =============================================================================

/**
 * Create a WorkerToolContext backed by a CorrelatedTransport.
 *
 * This provides full MCP sampling and elicitation capabilities
 * over the transport boundary. Matches the McpToolContext interface.
 */
function createWorkerContextFromTransport(
  transport: CorrelatedTransport,
  sessionId: string,
  nextLsn: () => number,
  rawTransport: WorkerTransport
): WorkerToolContext {
  let sampleSeq = 0
  let elicitSeq = 0

  // ---------------------------------------------------------------------------
  // Sample Implementation
  // ---------------------------------------------------------------------------

  function* sampleImpl(config: WorkerSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls> {
    const sampleId = `${sessionId}:sample:${++sampleSeq}`
    const promptText = getPromptText(config)
    const messages = getMessages(config)

    // Build request payload
    const payload: Record<string, unknown> = {
      messages,
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
      payload.tools = (configAny.tools as SamplingToolDefinition[]).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema instanceof Object && 'parse' in tool.inputSchema
          ? zodToJsonSchema(tool.inputSchema as z.ZodType)
          : tool.inputSchema,
      }))
      payload.toolChoice = configAny.toolChoice ?? 'auto'
    }

    // Send request through correlated transport
    const stream = transport.request<unknown, ElicitResponse>({
      id: sampleId,
      kind: 'elicit',
      type: 'sample',
      payload,
    })

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream

    // Consume until response
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

    // Build result based on what was requested
    if ('schema' in config && configAny.schema) {
      // Structured output result
      const toolCallId = generateId(`${sampleId}:schema`)
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

    if ('tools' in config && configAny.tools) {
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

  function* sampleToolsImpl(config: WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages): Operation<SampleToolsResult> {
    const maxAttempts = (config.retries ?? 2) + 1
    let lastResult: SampleResultWithToolCalls | undefined
    let currentConfig = config

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = yield* sampleImpl({
        ...currentConfig,
        toolChoice: currentConfig.toolChoice ?? 'required',
      } as WorkerSampleConfigToolsPrompt | WorkerSampleConfigToolsMessages) as Operation<SampleResultWithToolCalls>

      lastResult = result

      if (result.stopReason === 'toolUse' && result.toolCalls && result.toolCalls.length > 0) {
        return result as SampleToolsResult
      }

      // Add retry hint for next attempt
      if (attempt < maxAttempts && 'prompt' in currentConfig) {
        currentConfig = {
          ...currentConfig,
          prompt: `${currentConfig.prompt}\n\nPlease call one of the available tools.`,
        } as WorkerSampleToolsConfig
      }
    }

    throw new SampleValidationError(
      'sampleTools',
      maxAttempts,
      lastResult!,
      `Model did not call any tools after ${maxAttempts} attempts`
    )
  }

  function* sampleSchemaImpl<T>(config: WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>> {
    const maxAttempts = (config.retries ?? 2) + 1
    let lastResult: SampleResultWithParsed<T> | undefined
    let currentConfig = config

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = yield* sampleImpl(currentConfig as WorkerSampleConfigSchemaPrompt | WorkerSampleConfigSchemaMessages) as Operation<SampleResultWithParsed<T>>

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
      if (attempt < maxAttempts && 'prompt' in currentConfig) {
        const errorHint = result.parseError?.message ?? 'Invalid response format'
        currentConfig = {
          ...currentConfig,
          prompt: `${currentConfig.prompt}\n\nPrevious attempt failed: ${errorHint}. Please provide a valid response.`,
        } as WorkerSampleSchemaConfig<T>
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
  // Elicit Implementation
  // ---------------------------------------------------------------------------

  function* elicitImpl<T>(
    key: string,
    options: { message: string; schema: Record<string, unknown> }
  ): Operation<ElicitResult<unknown, T>> {
    const elicitId = `${sessionId}:elicit:${++elicitSeq}`

    // Send request through correlated transport
    const stream = transport.request<unknown, ElicitResponse>({
      id: elicitId,
      kind: 'elicit',
      type: 'elicit',
      payload: {
        key,
        message: options.message,
        schema: options.schema,
      },
    })

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream

    // Consume until response
    let result = yield* subscription.next()
    while (!result.done) {
      result = yield* subscription.next()
    }

    const response = result.value

    if (response.status === 'accepted') {
      const parsedContent = response.content as T
      const toolUseId = `elicit_core_${elicitId}`

      // Build exchange using MCP format
      const request: McpMessage & { role: 'assistant' } = {
        role: 'assistant' as const,
        content: [{
          type: 'tool_use' as const,
          id: toolUseId,
          name: key,
          input: {},
        }],
      }
      const responseMsg: McpMessage & { role: 'user' } = {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          toolUseId,
          content: [{ type: 'text' as const, text: JSON.stringify(parsedContent) }],
        }],
      }
      const exchange = {
        context: {} as unknown,
        request,
        response: responseMsg,
        messages: [request, responseMsg] as [McpMessage, McpMessage],
        withArguments(fn: (ctx: unknown) => Record<string, unknown>): [McpMessage, McpMessage] {
          const args = fn({})
          const requestWithArgs: McpMessage & { role: 'assistant' } = {
            role: 'assistant' as const,
            content: [{
              type: 'tool_use' as const,
              id: toolUseId,
              name: key,
              input: args,
            }],
          }
          return [requestWithArgs, responseMsg]
        },
      }

      return { action: 'accept' as const, content: parsedContent, exchange } as ElicitResult<unknown, T>
    }

    if (response.status === 'declined') {
      return { action: 'decline' }
    }

    return { action: 'cancel' }
  }

  // ---------------------------------------------------------------------------
  // Return Context Object
  // ---------------------------------------------------------------------------

  return {
    log(level: LogLevel, message: string): void {
      // Log is fire-and-forget, use raw transport directly
      rawTransport.send({
        type: 'log',
        level,
        message,
        lsn: nextLsn(),
      })
    },

    progress(message: string, progressValue?: number): void {
      // Progress is fire-and-forget, use raw transport directly
      rawTransport.send({
        type: 'progress',
        message,
        ...(progressValue !== undefined && { progress: progressValue }),
        lsn: nextLsn(),
      })
    },

    // Sample with overloads
    sample(config: WorkerSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls> {
      return sampleImpl(config)
    },

    // Sample helpers
    sampleTools(config: WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages): Operation<SampleToolsResult> {
      return sampleToolsImpl(config)
    },

    sampleSchema<T>(config: WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>> {
      return sampleSchemaImpl(config)
    },

    // Elicit
    elicit<T>(
      key: string,
      options: { message: string; schema: Record<string, unknown> }
    ): Operation<ElicitResult<unknown, T>> {
      return elicitImpl(key, options)
    },
  }
}

// =============================================================================
// RE-EXPORT REGISTRY HELPER
// =============================================================================

export { createWorkerToolRegistry } from './worker-runner.ts'
