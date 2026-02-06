/**
 * Worker Runner
 *
 * This module runs inside a worker thread and executes tool generators.
 * It uses @sweatpants/core's worker transport for communication with the host.
 *
 * ## Lifecycle
 *
 * 1. Worker starts via @effectionx/worker's workerMain()
 * 2. Receives init data with tool name, params, sessionId
 * 3. Looks up tool in registry, creates MCP context
 * 4. Executes tool handler, sending requests (sample/elicit/progress) to host
 * 5. Returns final result to host
 *
 * ## Architecture
 *
 * Uses @sweatpants/core's worker transport:
 * - Worker sends requests via send.stream() (sample, elicit)
 * - Host processes requests and returns responses
 * - Progress/log are fire-and-forget (logged locally)
 *
 * @packageDocumentation
 */

import {
  runToolWorker as coreRunToolWorker,
  type WorkerToolContext as CoreWorkerToolContext,
  type WorkerInitData as CoreWorkerInitData,
  type WorkerMessage,
  type WorkerSampleResponse,
  type WorkerElicitResponse,
} from '@sweatpants/core/transport/worker'
import type { Operation } from 'effection'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
  WorkerToolRegistry,
  WorkerToolContext,
  WorkerSampleConfig,
  WorkerSampleConfigSchemaPrompt,
  WorkerSampleConfigSchemaMessages,
  WorkerSampleConfigToolsPrompt,
  WorkerSampleConfigToolsMessages,
  WorkerSampleToolsConfig,
  WorkerSampleToolsConfigMessages,
  WorkerSampleSchemaConfig,
  WorkerSampleSchemaConfigMessages,
} from './worker-types.js'
import type {
  Message,
  ExtendedMessage,
  LogLevel,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
  ElicitResult,
  SamplingToolDefinition,
} from '../mcp-tool-types.js'
import {
  createRawSampleExchange,
  createStructuredSampleExchange,
  SampleValidationError,
} from '../mcp-tool-types.js'

// =============================================================================
// TYPE CONVERSION HELPERS
// =============================================================================

/**
 * Convert framework Message/ExtendedMessage to core WorkerMessage.
 */
function toWorkerMessage(msg: Message | ExtendedMessage): WorkerMessage {
  // If it's a basic Message with string content
  if (typeof msg.content === 'string') {
    return {
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }
  }
  
  // It's an McpMessage with content blocks - pass through
  // The core transport supports the same content block structure
  return msg as WorkerMessage
}

/**
 * Convert tool definition to core format.
 * Handles both Zod schemas and raw JSON schemas.
 * Zod schemas are converted to JSON Schema since they contain functions
 * that can't be cloned for postMessage to the host thread.
 */
function toWorkerToolDefinition(tool: SamplingToolDefinition): {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
} {
  // Check if inputSchema is a Zod type (has safeParse) and convert to JSON Schema
  const schema = tool.inputSchema as unknown
  const isZodSchema = schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  const inputSchema = isZodSchema
    ? zodToJsonSchema(schema as any, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>
    : tool.inputSchema as Record<string, unknown>

  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema,
  }
}

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool session worker.
 *
 * This is the entry point for the worker thread. It uses @sweatpants/core's
 * runToolWorker to handle the communication protocol, and wraps the core
 * context with MCP-specific functionality (exchanges, retry helpers).
 *
 * @param registry - Registry of available tools
 */
export async function runWorker(registry: WorkerToolRegistry): Promise<void> {
  await coreRunToolWorker(function* (initData: CoreWorkerInitData, coreCtx: CoreWorkerToolContext) {
    const { toolName, params, sessionId } = initData

    // Look up tool
    const tool = registry.get(toolName)
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`)
    }

    // Create MCP tool context that wraps core context
    const ctx = createMcpWorkerContext(coreCtx, sessionId)

    // Execute the tool
    return yield* tool.handler(params, ctx) as Operation<unknown>
  })
}

// =============================================================================
// MCP WORKER CONTEXT
// =============================================================================

/**
 * Create an MCP-flavored worker context from the core context.
 *
 * This wraps the core's simple sample/elicit with:
 * - Exchange construction for history accumulation
 * - Retry helpers (sampleTools, sampleSchema)
 * - Proper typing for MCP sample configs
 */
function createMcpWorkerContext(
  coreCtx: CoreWorkerToolContext,
  sessionId: string
): WorkerToolContext {
  let toolCallIdCounter = 0
  const generateToolCallId = () => `${sessionId}:tc:${++toolCallIdCounter}`

  // Helper to extract prompt text for exchange construction
  function extractPromptText(config: WorkerSampleConfig): string {
    if ('prompt' in config && config.prompt) {
      return config.prompt
    }
    if ('messages' in config && config.messages) {
      const lastUserMsg = [...config.messages].reverse().find(m => m.role === 'user')
      if (lastUserMsg) {
        return typeof lastUserMsg.content === 'string' 
          ? lastUserMsg.content 
          : '[complex content]'
      }
    }
    return ''
  }

  // Helper to build messages for core sample
  function buildMessages(config: WorkerSampleConfig): WorkerMessage[] {
    if ('prompt' in config && config.prompt) {
      return [{ role: 'user', content: config.prompt }]
    }
    if ('messages' in config && config.messages) {
      return config.messages.map(toWorkerMessage)
    }
    return []
  }

  // The unified sample implementation
  function* sampleImpl(config: WorkerSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls> {
    const messages = buildMessages(config)
    const promptText = extractPromptText(config)

    // Build core sample options
    const coreOptions: Parameters<typeof coreCtx.sample>[0] = {
      messages,
      ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
    }

    // Handle schema (convert Zod to JSON schema marker)
    if ('schema' in config && config.schema) {
      const schema = config.schema as unknown
      const isZodSchema = typeof (schema as { safeParse?: unknown }).safeParse === 'function'
      coreOptions.schema = isZodSchema
        ? zodToJsonSchema(schema as any, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>
        : schema as Record<string, unknown>
    }

    // Handle tools
    if ('tools' in config && config.tools) {
      coreOptions.tools = config.tools.map(toWorkerToolDefinition)
      if (config.toolChoice !== undefined) {
        coreOptions.toolChoice = config.toolChoice
      }
    }

    // Call core sample
    const response: WorkerSampleResponse = yield* coreCtx.sample(coreOptions)

    // Build result based on what was requested
    if ('schema' in config && config.schema) {
      // Schema sample - parse and build structured exchange
      const parsed = response.parsed ?? null
      const parseError = response.parseError

      const exchange = parsed !== null
        ? createStructuredSampleExchange(promptText, parsed, generateToolCallId())
        : createRawSampleExchange(promptText, response.text)

      const result: SampleResultWithParsed<unknown> = {
        text: response.text,
        ...(response.model !== undefined && { model: response.model }),
        ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
        parsed,
        ...(parseError !== undefined && { parseError }),
        exchange: exchange as SampleResultWithParsed<unknown>['exchange'],
      }
      return result
    }

    if ('tools' in config && config.tools && response.toolCalls) {
      // Tools sample
      const exchange = createRawSampleExchange(promptText, response.text)
      const result: SampleResultWithToolCalls = {
        text: response.text,
        ...(response.model !== undefined && { model: response.model }),
        ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
        exchange,
        toolCalls: response.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      }
      return result
    }

    // Plain sample
    const exchange = createRawSampleExchange(promptText, response.text)
    const result: SampleResultBase = {
      text: response.text,
      ...(response.model !== undefined && { model: response.model }),
      ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
      exchange,
    }
    return result
  }

  // The context object
  const ctx: WorkerToolContext = {
    log(level: LogLevel, message: string): Operation<void> {
      coreCtx.log(level, message)
      // Return a no-op operation so callers can yield* ctx.log(...)
      return {
        *[Symbol.iterator]() {
          // No-op - logging is fire-and-forget
        },
      }
    },

    progress(message: string, progressValue?: number): Operation<void> {
      // Core context has fire-and-forget progress
      coreCtx.progress(message, progressValue)
      // Return a no-op operation for backpressure compatibility
      return {
        *[Symbol.iterator]() {
          // No-op - progress is fire-and-forget in the new model
        },
      }
    },

    // Alias for progress() - MCP tools call ctx.notify() instead of ctx.progress()
    notify(message: string, progressValue?: number): Operation<void> {
      return ctx.progress(message, progressValue)
    },

    // Sample - delegates to sampleImpl (overloads are defined in the interface)
    sample: ((config: WorkerSampleConfig) => sampleImpl(config)) as WorkerToolContext['sample'],

    *sampleTools(config: WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages): Operation<SampleToolsResult> {
      const retries = config.retries ?? 2
      let lastResult: SampleResultBase | SampleResultWithToolCalls | undefined

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with tools
        const sampleConfig: WorkerSampleConfigToolsPrompt | WorkerSampleConfigToolsMessages = 'prompt' in config
          ? {
              prompt: config.prompt,
              tools: config.tools,
              toolChoice: config.toolChoice ?? 'required',
              ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
              ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
              ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
            }
          : {
              messages: config.messages,
              tools: config.tools,
              toolChoice: config.toolChoice ?? 'required',
              ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
              ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
              ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
            }

        const result = yield* sampleImpl(sampleConfig)
        lastResult = result as SampleResultBase | SampleResultWithToolCalls

        // Check if we got tool calls
        if ('toolCalls' in result && result.toolCalls && result.toolCalls.length > 0) {
          return {
            ...result,
            toolCalls: result.toolCalls as [typeof result.toolCalls[0], ...typeof result.toolCalls],
            stopReason: 'toolUse',
          } as SampleToolsResult
        }

        // If this wasn't the last attempt, we could add a retry hint
        // For now, just retry with the same config
      }

      throw new SampleValidationError(
        'sampleTools',
        retries + 1,
        lastResult!,
        `Model did not return tool calls after ${retries + 1} attempts`
      )
    },

    *sampleSchema<T>(config: WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>> {
      const retries = config.retries ?? 2
      let lastResult: SampleResultWithParsed<T> | undefined

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with schema
        const sampleConfig: WorkerSampleConfigSchemaPrompt<T> | WorkerSampleConfigSchemaMessages<T> = 'prompt' in config
          ? {
              prompt: config.prompt,
              schema: config.schema,
              ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
              ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
              ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
            }
          : {
              messages: config.messages,
              schema: config.schema,
              ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
              ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
              ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
            }

        const result = (yield* sampleImpl(sampleConfig)) as SampleResultWithParsed<T>
        lastResult = result

        // Check if we got valid parsed output
        if (result.parsed !== null) {
          return {
            text: result.text,
            ...(result.model !== undefined && { model: result.model }),
            ...(result.stopReason !== undefined && { stopReason: result.stopReason }),
            parsed: result.parsed,
            exchange: result.exchange as SampleSchemaResult<T>['exchange'],
          }
        }

        // If this wasn't the last attempt, we could add a retry hint
      }

      throw new SampleValidationError(
        'sampleSchema',
        retries + 1,
        lastResult!,
        `Schema parsing failed after ${retries + 1} attempts: ${lastResult?.parseError?.message ?? 'unknown error'}`
      )
    },

    *elicit<T>(
      key: string,
      options: {
        message: string
        schema?: Record<string, unknown>
        context?: Record<string, unknown>
        [key: string]: unknown
      }
    ): Operation<ElicitResult<unknown, T>> {
      const { message, schema, context, ...spreadContext } = options
      const resolvedContext = context !== undefined
        ? context
        : (Object.keys(spreadContext).length > 0 ? spreadContext : undefined)

      const response: WorkerElicitResponse = yield* coreCtx.elicit(key, {
        message,
        schema: schema ?? { type: 'object' },
        ...(resolvedContext !== undefined && { context: resolvedContext }),
      })

      // Map core response to MCP elicit result
      if (response.status === 'accepted') {
        const content = response.content as T
        const toolUseId = `elicit_${sessionId}_${key}_${Date.now()}`

        // Build exchange
        const request = {
          role: 'assistant' as const,
          content: [{
            type: 'tool_use' as const,
            id: toolUseId,
            name: key,
            input: {},
          }],
        }
        const responseMsg = {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            toolUseId,
            content: [{ type: 'text' as const, text: JSON.stringify(content) }],
          }],
        }

        return {
          action: 'accept',
          content,
          exchange: {
            context: (resolvedContext ?? {}) as unknown,
            request,
            response: responseMsg,
            messages: [request, responseMsg] as [typeof request, typeof responseMsg],
            withArguments(fn: (ctx: unknown) => Record<string, unknown>) {
              const args = fn(resolvedContext ?? {})
              const requestWithArgs = {
                role: 'assistant' as const,
                content: [{
                  type: 'tool_use' as const,
                  id: toolUseId,
                  name: key,
                  input: args,
                }],
              }
              return [requestWithArgs, responseMsg] as [typeof requestWithArgs, typeof responseMsg]
            },
          },
        }
      }

      if (response.status === 'declined') {
        return { action: 'decline' }
      }

      return { action: 'cancel' }
    },
  }

  return ctx
}

// =============================================================================
// SIMPLE TOOL REGISTRY
// =============================================================================

/**
 * Create a simple in-memory tool registry.
 *
 * @param tools - Array of tools to register
 * @returns The registry
 */
export function createWorkerToolRegistry(
  tools: Array<{ name: string; handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown> }>
): WorkerToolRegistry {
  const map = new Map<string, { name: string; handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown> }>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }

  return {
    get(name: string) {
      return map.get(name) ?? null
    },
    list() {
      return Array.from(map.keys())
    },
  }
}
