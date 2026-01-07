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
import type {
  BranchContext,
  BranchOptions,
  BranchSampleConfig,
  BranchServerContext,
  BranchLimits,
  Message,
  SampleResult,
} from './branch-types'
import {
  BranchDepthError,
} from './branch-types'
import type {
  ElicitConfig,
  ElicitResult,
  LogLevel,
} from './types'
import type { FinalizedBranchTool } from './branch-builder'

// =============================================================================
// MCP CLIENT INTERFACE
// =============================================================================

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
    messages: Message[],
    options?: {
      systemPrompt?: string
      maxTokens?: number
    }
  ): Operation<SampleResult>

  /**
   * Request user input.
   * Maps to MCP: elicitation/create
   */
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>>

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

  /** Tokens used so far */
  tokensUsed: number
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
    sample(config: BranchSampleConfig): Operation<SampleResult> {
      return {
        *[Symbol.iterator]() {
          let messages: Message[]

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
          const sampleOptions: { systemPrompt?: string; maxTokens?: number } = {}
          const effectiveSystemPrompt = config.systemPrompt ?? state.systemPrompt
          if (effectiveSystemPrompt !== undefined) {
            sampleOptions.systemPrompt = effectiveSystemPrompt
          }
          if (config.maxTokens !== undefined) {
            sampleOptions.maxTokens = config.maxTokens
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

          // Track token usage (estimate - real implementation would get from response)
          // state.tokensUsed += result.usage?.totalTokens ?? 0

          return result
        },
      }
    },

    // User backchannel
    elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>> {
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

          const newState: BranchState = {
            messages: newMessages,
            parentMessages: state.messages as readonly Message[],
            depth: newDepth,
            limits: newLimits,
            tokensUsed: 0,
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

      // Create initial branch state
      const initialState: BranchState = {
        messages: [],
        parentMessages: options.parentMessages ?? [],
        depth: 0,
        limits,
        tokensUsed: 0,
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
        const clientResult = yield* clientFn(handoff, branchCtx)

        // Phase 2: after()
        result = yield* after(handoff, clientResult, serverCtx, validatedParams)
      } else if (tool.execute) {
        // Simple execute with branch context
        const branchCtx = createBranchContext(initialState, client)
        result = yield* tool.execute(validatedParams, branchCtx)
      } else {
        throw new Error(`Tool "${tool.name}" has no execute or handoff config`)
      }

      return result
    },
  }
}
