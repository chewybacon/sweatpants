/**
 * Branch Execution Runtime
 *
 * Executes branch-based tools by:
 * - Managing conversation context per branch
 * - Routing sample/elicit calls to the MCP client
 * - Handling sub-branch creation and execution
 * - Enforcing limits (depth, tokens, timeout)
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
  McpToolContext,
  McpToolBranchOptions,
  McpToolSampleConfig,
  McpToolServerContext,
  McpToolLimits,
  Message,
  ExtendedMessage,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolDefinition,
  SamplingToolChoice,
  ElicitConfig,
  ElicitResult,
  LogLevel,
  SampleToolsConfig,
  SampleToolsConfigMessages,
  SampleSchemaConfig,
  SampleSchemaConfigMessages,
  SampleToolsResult,
  SampleSchemaResult,
} from './mcp-tool-types.ts'
import {
  McpToolDepthError,
  McpToolTokenError,
  SampleValidationError,
} from './mcp-tool-types.ts'
import type { FinalizedMcpTool, FinalizedMcpToolWithElicits } from './mcp-tool-builder.ts'
import type { ElicitsMap } from './mcp-tool-types.ts'

// Legacy type aliases for backward compatibility
type BranchContext = McpToolContext
type BranchOptions = McpToolBranchOptions
type BranchSampleConfig = McpToolSampleConfig
type BranchServerContext = McpToolServerContext
type BranchLimits = McpToolLimits
const BranchDepthError = McpToolDepthError
const BranchTokenError = McpToolTokenError

// Type alias that accepts both FinalizedMcpTool and FinalizedMcpToolWithElicits
type FinalizedBranchTool<TName extends string, TParams, THandoff, TClient, TResult> = 
  | FinalizedMcpTool<TName, TParams, THandoff, TClient, TResult>
  | FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, ElicitsMap>

// =============================================================================
// MCP CLIENT INTERFACE
// =============================================================================

/**
 * Options for MCP sampling requests.
 */
export interface BranchSampleOptions {
  systemPrompt?: string
  maxTokens?: number
  tools?: SamplingToolDefinition[]
  toolChoice?: SamplingToolChoice
  schema?: Record<string, unknown>
}

/**
 * Interface for the MCP client that provides sampling/elicitation.
 * This is what the runtime uses to communicate with the actual MCP client.
 */
export interface BranchMCPClient {
  /**
   * Request an LLM completion.
   * Maps to MCP: sampling/createMessage
   */
  sample(
    messages: ExtendedMessage[],
    options?: BranchSampleOptions
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>

  /**
   * Request user input.
   * Maps to MCP: elicitation/create
   */
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<unknown, T>>

  /**
   * Send a log message.
   * Maps to MCP: notifications/message
   */
  log(level: LogLevel, message: string): Operation<void>

  /**
   * Send a progress notification.
   * Maps to MCP: notifications/progress
   */
  notify(message: string, progress?: number): Operation<void>

  /**
   * Client capabilities.
   */
  capabilities: {
    elicitation: boolean
    sampling: boolean
  }
}

// =============================================================================
// BRANCH STATE
// =============================================================================

/**
 * Token tracking for best-effort budgeting.
 *
 * This is intentionally approximate: we estimate tokens from string length.
 * If/when MCP sampling returns precise usage, we can swap this out.
 */
interface TokenTracker {
  used: number
  budget?: number
  parent?: TokenTracker
}

function estimateTokensFromText(text: string): number {
  // Rule of thumb: ~4 chars per token.
  return Math.ceil(text.length / 4)
}

/**
 * Extract text content from a message for token estimation.
 * Handles both simple string content and MCP content blocks.
 */
function getMessageTextContent(msg: ExtendedMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content
  }
  if (msg.content === null || msg.content === undefined) {
    return ''
  }
  // MCP content blocks
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]
  return blocks
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return JSON.stringify(block.input)
      if (block.type === 'tool_result') {
        const innerBlocks = Array.isArray(block.content) ? block.content : [block.content]
        return innerBlocks.map(b => b.type === 'text' ? b.text : '').join('')
      }
      return ''
    })
    .join('')
}

function estimateTokensFromConversation(options: {
  systemPrompt?: string
  messages: ExtendedMessage[]
  completion: string
}): number {
  const system = options.systemPrompt ? estimateTokensFromText(options.systemPrompt) : 0
  const convo = options.messages.reduce((sum, msg) => sum + estimateTokensFromText(getMessageTextContent(msg)), 0)
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

/**
 * Internal state for a branch.
 */
interface BranchState {
  /** Messages in this branch's conversation */
  messages: Message[]

  /** System prompt for this branch */
  systemPrompt?: string

  /** Parent messages (frozen snapshot) */
  parentMessages: readonly Message[]

  /** Parent system prompt */
  parentSystemPrompt?: string

  /** Current depth in branch tree */
  depth: number

  /** Limits for this branch */
  limits: BranchLimits

  /** Token tracker for budgets (shared with parents) */
  tokenTracker: TokenTracker
}

// =============================================================================
// BRANCH CONTEXT IMPLEMENTATION
// =============================================================================

/**
 * Create a BranchContext for executing a branch.
 */
function createBranchContext(
  state: BranchState,
  client: BranchMCPClient
): BranchContext {
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
    // TODO: Implement schema parsing at response level in Phase 4
    // Using type assertion because the implementation handles all overload variants,
    // but TypeScript can't verify this without conditional types at the implementation level.
    sample: ((config: BranchSampleConfig) => {
      return {
        *[Symbol.iterator]() {
          let messages: ExtendedMessage[]

          if ('prompt' in config && config.prompt) {
            // Auto-tracked mode: append to branch messages
            const userMessage: Message = { role: 'user', content: config.prompt }
            messages = [...state.messages, userMessage]
          } else if ('messages' in config && config.messages) {
            // Explicit mode: use provided messages
            messages = config.messages
          } else {
            throw new Error('sample() requires either prompt or messages')
          }

          // Build options, only including defined values
          const sampleOptions: BranchSampleOptions = {}
          const effectiveSystemPrompt = config.systemPrompt ?? state.systemPrompt
          if (effectiveSystemPrompt !== undefined) {
            sampleOptions.systemPrompt = effectiveSystemPrompt
          }
          if (config.maxTokens !== undefined) {
            sampleOptions.maxTokens = config.maxTokens
          }
          
          // Pass through tools if provided (convert Zod to JSON Schema)
          if ('tools' in config && config.tools) {
            sampleOptions.tools = config.tools.map(tool => {
              const def: SamplingToolDefinition = {
                name: tool.name,
                inputSchema: 'safeParse' in tool.inputSchema 
                  ? zodToJsonSchema(tool.inputSchema as any)
                  : tool.inputSchema,
              }
              if (tool.description !== undefined) {
                def.description = tool.description
              }
              return def
            })
          }
          if ('toolChoice' in config && config.toolChoice) {
            sampleOptions.toolChoice = config.toolChoice
          }
          
          // Convert schema from Zod to JSON Schema if provided
          if ('schema' in config && config.schema) {
            sampleOptions.schema = zodToJsonSchema(config.schema as any)
          }

          // Call the MCP client
          const result = yield* client.sample(messages, sampleOptions)

          // If using auto-tracked mode, update branch messages
          if ('prompt' in config && config.prompt) {
            state.messages.push(
              { role: 'user', content: config.prompt },
              { role: 'assistant', content: result.text }
            )
          }

          // Track token usage (best-effort estimate).
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
    }) as McpToolContext['sample'],

    // Sample with guaranteed tool calls
    sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult> {
      const maxRetries = config.retries ?? 2
      const toolChoice = config.toolChoice ?? 'required'
      
      return {
        *[Symbol.iterator]() {
          let lastResult: SampleResultBase | SampleResultWithToolCalls | undefined
          
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Build the sample config
            let sampleConfig: McpToolSampleConfig
            
            if ('prompt' in config) {
              const retryHint = attempt > 0 
                ? `\n\n[IMPORTANT: You must call one of the available tools. Your previous response did not include a tool call.]`
                : ''
              sampleConfig = {
                prompt: config.prompt + retryHint,
                tools: config.tools,
                toolChoice,
                ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
                ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
              } as McpToolSampleConfig
            } else {
              // Messages mode - add retry hint to last message if retrying
              let messages = config.messages
              if (attempt > 0 && messages.length > 0) {
                const lastMsg = messages[messages.length - 1]!
                messages = [
                  ...messages.slice(0, -1),
                  { ...lastMsg, content: lastMsg.content + '\n\n[IMPORTANT: You must call one of the available tools.]' }
                ]
              }
              sampleConfig = {
                messages,
                tools: config.tools,
                toolChoice,
                ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
                ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
              } as McpToolSampleConfig
            }
            
            // Call sample
            const result = yield* client.sample(
              'prompt' in sampleConfig 
                ? [...state.messages, { role: 'user' as const, content: sampleConfig.prompt as string }]
                : sampleConfig.messages,
              {
                ...(sampleConfig.systemPrompt !== undefined ? { systemPrompt: sampleConfig.systemPrompt } : {}),
                ...(sampleConfig.maxTokens !== undefined ? { maxTokens: sampleConfig.maxTokens } : {}),
                tools: config.tools.map(tool => ({
                  name: tool.name,
                  inputSchema: 'safeParse' in tool.inputSchema 
                    ? zodToJsonSchema(tool.inputSchema as any)
                    : tool.inputSchema,
                  ...(tool.description !== undefined ? { description: tool.description } : {}),
                })),
                toolChoice,
              }
            )
            
            lastResult = result
            
            // Validate: must have tool calls
            if (result.stopReason === 'toolUse' && 'toolCalls' in result && result.toolCalls.length > 0) {
              // Update branch messages if using prompt mode
              if ('prompt' in config) {
                state.messages.push(
                  { role: 'user', content: config.prompt },
                  { role: 'assistant', content: result.text }
                )
              }
              
              return result as SampleToolsResult
            }
          }
          
          // All retries exhausted
          throw new SampleValidationError(
            'sampleTools',
            maxRetries + 1,
            lastResult!,
            `sampleTools failed after ${maxRetries + 1} attempts: model did not return tool calls`
          )
        },
      }
    },

    // Sample with guaranteed parsed schema
    sampleSchema<T>(config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>> {
      const maxRetries = config.retries ?? 2
      
      return {
        *[Symbol.iterator]() {
          let lastResult: SampleResultBase | SampleResultWithParsed<T> | undefined
          let lastError: string | undefined
          
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Build the sample config
            let sampleConfig: McpToolSampleConfig
            
            if ('prompt' in config) {
              const retryHint = attempt > 0 && lastError
                ? `\n\n[IMPORTANT: Your previous response was invalid: ${lastError}. Please respond with valid JSON matching the schema.]`
                : ''
              sampleConfig = {
                prompt: config.prompt + retryHint,
                schema: config.schema,
                ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
                ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
              } as McpToolSampleConfig
            } else {
              // Messages mode - add retry hint to last message if retrying
              let messages = config.messages
              if (attempt > 0 && messages.length > 0 && lastError) {
                const lastMsg = messages[messages.length - 1]!
                messages = [
                  ...messages.slice(0, -1),
                  { ...lastMsg, content: lastMsg.content + `\n\n[IMPORTANT: Your previous response was invalid: ${lastError}. Please respond with valid JSON.]` }
                ]
              }
              sampleConfig = {
                messages,
                schema: config.schema,
                ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
                ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
              } as McpToolSampleConfig
            }
            
            // Call sample
            const result = (yield* client.sample(
              'prompt' in sampleConfig 
                ? [...state.messages, { role: 'user' as const, content: sampleConfig.prompt as string }]
                : sampleConfig.messages,
              {
                ...(sampleConfig.systemPrompt !== undefined ? { systemPrompt: sampleConfig.systemPrompt } : {}),
                ...(sampleConfig.maxTokens !== undefined ? { maxTokens: sampleConfig.maxTokens } : {}),
                schema: zodToJsonSchema(config.schema as any),
              }
            )) as SampleResultWithParsed<T>
            
            lastResult = result
            
            // Validate: must have parsed value
            if ('parsed' in result && result.parsed !== null) {
              // Update branch messages if using prompt mode
              if ('prompt' in config) {
                state.messages.push(
                  { role: 'user', content: config.prompt },
                  { role: 'assistant', content: result.text }
                )
              }
              
              return { ...result, parsed: result.parsed } as SampleSchemaResult<T>
            }
            
            // Capture error for retry hint
            if ('parseError' in result && result.parseError) {
              lastError = result.parseError.message
            } else {
              lastError = 'Response could not be parsed'
            }
          }
          
          // All retries exhausted
          throw new SampleValidationError(
            'sampleSchema',
            maxRetries + 1,
            lastResult!,
            `sampleSchema failed after ${maxRetries + 1} attempts: ${lastError}`
          )
        },
      }
    },

    // User backchannel
    elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<unknown, T>> {
      return client.elicit(config)
    },

    // Sub-branches
    branch<T>(
      fn: (ctx: BranchContext) => Operation<T>,
      options: BranchOptions = {}
    ): Operation<T> {
      return {
        *[Symbol.iterator]() {
          // Check depth limit
          const newDepth = state.depth + 1
          const maxDepth = options.maxDepth ?? state.limits.maxDepth

          if (maxDepth !== undefined && newDepth > maxDepth) {
            throw new BranchDepthError(newDepth, maxDepth)
          }

          // Build new branch state
          const inheritMessages = options.inheritMessages ?? true
          const inheritSystemPrompt = options.inheritSystemPrompt ?? true

          let newMessages: Message[] = []
          if (inheritMessages) {
            newMessages = [...state.messages]
          }
          if (options.messages) {
            newMessages = [...newMessages, ...options.messages]
          }

          // Build limits, preserving undefined handling
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

          const newState: BranchState = {
            messages: newMessages,
            parentMessages: state.messages as readonly Message[],
            depth: newDepth,
            limits: newLimits,
            tokenTracker: subTokenTracker,
          }

          // Set optional properties only if defined
          const newSystemPrompt = options.systemPrompt ?? (inheritSystemPrompt ? state.systemPrompt : undefined)
          if (newSystemPrompt !== undefined) {
            newState.systemPrompt = newSystemPrompt
          }
          if (state.systemPrompt !== undefined) {
            newState.parentSystemPrompt = state.systemPrompt
          }

          // Create context for sub-branch
          const subContext = createBranchContext(newState, client)

          // Execute sub-branch
          // TODO: Add timeout handling with Effection
          const result = yield* fn(subContext)

          return result
        },
      }
    },

    // Logging
    log(level: LogLevel, message: string): Operation<void> {
      return client.log(level, message)
    },

    notify(message: string, progress?: number): Operation<void> {
      return client.notify(message, progress)
    },
  }
}

// =============================================================================
// TOOL EXECUTION
// =============================================================================

/**
 * Options for running a branch tool.
 */
export interface RunBranchToolOptions {
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
 * Execute a branch-based tool.
 *
 * @param tool - The tool to execute
 * @param params - Tool parameters
 * @param client - MCP client for sample/elicit
 * @param options - Execution options
 */
export function runBranchTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
>(
  tool: FinalizedBranchTool<TName, TParams, THandoff, TClient, TResult>,
  params: TParams,
  client: BranchMCPClient,
  options: RunBranchToolOptions = {}
): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      const callId = options.callId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const signal = options.signal ?? new AbortController().signal

      // Validate params
      const parseResult = tool.parameters.safeParse(params)
      if (!parseResult.success) {
        throw new Error(`Invalid params for tool "${tool.name}": ${parseResult.error.message}`)
      }
      const validatedParams = parseResult.data as TParams

      // Merge limits
      const limits: BranchLimits = {
        ...tool.limits,
        ...options.limits,
      }

      // Create server context
      const serverCtx: BranchServerContext = { callId, signal }

      const rootTokenTracker: TokenTracker = { used: 0 }
      if (limits.maxTokens !== undefined) {
        rootTokenTracker.budget = limits.maxTokens
      }

      // Create initial branch state
      const initialState: BranchState = {
        messages: [],
        parentMessages: options.parentMessages ?? [],
        depth: 0,
        limits,
        tokenTracker: rootTokenTracker,
      }

      // Set optional properties only if defined
      if (options.systemPrompt !== undefined) {
        initialState.systemPrompt = options.systemPrompt
        initialState.parentSystemPrompt = options.systemPrompt
      }

      let result: TResult

      if (tool.handoffConfig) {
        // Execute handoff pattern
        const { before, client: clientFn, after } = tool.handoffConfig

        // Phase 1: before()
        const handoff = yield* before(validatedParams, serverCtx)

        // Create branch context for client phase
        const branchCtx = createBranchContext(initialState, client)

        // Client phase
        // Cast needed because FinalizedBranchTool is a union type that may expect
        // McpToolContextWithElicits, but we provide McpToolContext which is runtime-compatible
        const clientResult = yield* clientFn(handoff, branchCtx as any)

        // Phase 2: after()
        result = yield* after(handoff, clientResult, serverCtx, validatedParams)
      } else if (tool.execute) {
        // Simple execute with branch context
        const branchCtx = createBranchContext(initialState, client)
        // Cast needed because tool.execute may expect McpToolContextWithElicits
        result = yield* tool.execute(validatedParams, branchCtx as any)
      } else {
        throw new Error(`Tool "${tool.name}" has no execute or handoff config`)
      }

      return result
    },
  }
}
