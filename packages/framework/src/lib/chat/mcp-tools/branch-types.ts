/**
 * Branch-Based Tool Execution Types
 *
 * Extends the MCP tool system with branch-based execution model.
 * Branches are server-driven generators that can:
 * - Call back to client for LLM (sample) or user input (elicit)
 * - Spawn sub-branches for structured concurrency
 * - Manage conversation context across the branch tree
 *
 * ## Mental Model
 *
 * Tool calls are branches off the main LLM timeline. Each branch:
 * - Receives parent context (optionally uses it)
 * - Runs a server-driven generator
 * - Can spawn sub-branches that reduce back
 * - Returns a single result to the parent
 *
 * ```
 * Main Timeline
 *     |
 *     +-- tool_call --> branch --> reduces back
 *     |                   |
 *     |                   +-- sample (LLM backchannel)
 *     |                   +-- elicit (user backchannel)
 *     |                   +-- branch (sub-branch) --> reduces back
 *     |
 *     v continues
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  ElicitConfig,
  ElicitResult,
  LogLevel,
  ModelPreferences,
} from './types'

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * Role in a conversation.
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * A message in a conversation.
 */
export interface Message {
  role: MessageRole
  content: string
}

// =============================================================================
// SAMPLE CONFIGURATION
// =============================================================================

/**
 * Base sample configuration (shared fields).
 */
interface SampleConfigBase {
  /** Optional system prompt override */
  systemPrompt?: string

  /** Maximum tokens to generate */
  maxTokens?: number

  /** Model preferences for the client */
  modelPreferences?: ModelPreferences

  /**
   * Optional Zod schema for structured output.
   * If provided, the response will be parsed and validated.
   */
  schema?: z.ZodType
}

/**
 * Sample with auto-tracked prompt (appends to branch context).
 */
export interface SampleConfigPrompt extends SampleConfigBase {
  /** The prompt to send (auto-tracked in branch context) */
  prompt: string
  messages?: never
}

/**
 * Sample with explicit messages (full control).
 */
export interface SampleConfigMessages extends SampleConfigBase {
  /** Explicit messages array (not auto-tracked) */
  messages: Message[]
  prompt?: never
}

/**
 * Configuration for a sampling request.
 * Supports two modes:
 * - `prompt`: Simple prompt string, auto-tracked in branch context
 * - `messages`: Explicit messages array, full control
 */
export type BranchSampleConfig = SampleConfigPrompt | SampleConfigMessages

/**
 * Result of a sampling request.
 */
export interface SampleResult {
  /** The generated text */
  text: string

  /** Model that generated the response */
  model?: string

  /** Why generation stopped */
  stopReason?: 'endTurn' | 'maxTokens' | 'toolUse' | string
}

// =============================================================================
// BRANCH OPTIONS
// =============================================================================

/**
 * Options for creating a sub-branch.
 */
export interface BranchOptions {
  // ---------------------------------------------------------------------------
  // Context inheritance
  // ---------------------------------------------------------------------------

  /**
   * Whether to inherit parent messages.
   * @default true
   */
  inheritMessages?: boolean

  /**
   * Whether to inherit parent system prompt.
   * @default true
   */
  inheritSystemPrompt?: boolean

  /**
   * Override/supplement messages for this branch.
   * If inheritMessages is true, these are appended.
   * If inheritMessages is false, these replace.
   */
  messages?: Message[]

  /**
   * Override system prompt for this branch.
   */
  systemPrompt?: string

  // ---------------------------------------------------------------------------
  // Limits
  // ---------------------------------------------------------------------------

  /**
   * Maximum branch depth from this point.
   * Prevents infinite recursion.
   */
  maxDepth?: number

  /**
   * Maximum total tokens for this branch and its children.
   */
  maxTokens?: number

  /**
   * Timeout in milliseconds for this branch.
   */
  timeout?: number

  // ---------------------------------------------------------------------------
  // Tool binding (future)
  // ---------------------------------------------------------------------------

  /**
   * Tools available to this branch for composition.
   * (Future: enables ctx.callTool() in sub-branches)
   */
  // tools?: Tool[]
}

/**
 * Limits configuration for tool execution.
 */
export interface BranchLimits {
  /** Maximum branch depth */
  maxDepth?: number

  /** Maximum total tokens across all branches */
  maxTokens?: number

  /** Timeout in milliseconds */
  timeout?: number
}

// =============================================================================
// BRANCH CONTEXT
// =============================================================================

/**
 * Context available in branch execution.
 *
 * Provides primitives for:
 * - Reading parent context
 * - Managing current branch conversation
 * - LLM backchannel (sample)
 * - User input backchannel (elicit)
 * - Spawning sub-branches
 *
 * @example
 * ```typescript
 * *client(handoff, ctx: BranchContext) {
 *   // Auto-tracked conversation
 *   const analysis = yield* ctx.sample({ prompt: 'Analyze...' })
 *
 *   // Sub-branch for focused task
 *   const detail = yield* ctx.branch(function* (subCtx) {
 *     return yield* subCtx.sample({ prompt: 'Detail...' })
 *   }, { inheritMessages: false })
 *
 *   // User confirmation
 *   const choice = yield* ctx.elicit({
 *     message: 'Confirm?',
 *     schema: z.object({ ok: z.boolean() })
 *   })
 *
 *   return { analysis, detail, confirmed: choice.action === 'accept' }
 * }
 * ```
 */
export interface BranchContext {
  // ---------------------------------------------------------------------------
  // Parent context (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Messages from the parent context.
   * This is the conversation history up to when this branch was created.
   * Read-only - modifications don't affect parent.
   */
  readonly parentMessages: readonly Message[]

  /**
   * System prompt from the parent context.
   * Undefined if no system prompt was set.
   */
  readonly parentSystemPrompt: string | undefined

  // ---------------------------------------------------------------------------
  // Current branch state
  // ---------------------------------------------------------------------------

  /**
   * Messages in this branch's conversation.
   * Auto-updated when using `sample({ prompt })` form.
   * Read-only view - use sample/elicit to modify.
   */
  readonly messages: readonly Message[]

  /**
   * Current depth in the branch tree.
   * Root branch is depth 0.
   */
  readonly depth: number

  // ---------------------------------------------------------------------------
  // LLM backchannel
  // ---------------------------------------------------------------------------

  /**
   * Request an LLM completion from the client.
   *
   * Two modes:
   * - `{ prompt }`: Auto-tracked in branch context
   * - `{ messages }`: Explicit control, not tracked
   *
   * Maps to MCP: `sampling/createMessage`
   *
   * @example Auto-tracked
   * ```typescript
   * // Appends to ctx.messages automatically
   * const result = yield* ctx.sample({ prompt: 'Summarize...' })
   * ```
   *
   * @example Explicit messages
   * ```typescript
   * // Full control, not tracked in ctx.messages
   * const result = yield* ctx.sample({
   *   messages: [
   *     ...ctx.parentMessages,
   *     { role: 'user', content: 'Custom...' }
   *   ]
   * })
   * ```
   */
  sample(config: BranchSampleConfig): Operation<SampleResult>

  // ---------------------------------------------------------------------------
  // User backchannel
  // ---------------------------------------------------------------------------

  /**
   * Request structured input from the user.
   *
   * Maps to MCP: `elicitation/create`
   *
   * @example
   * ```typescript
   * const choice = yield* ctx.elicit({
   *   message: 'Pick an option:',
   *   schema: z.object({
   *     option: z.enum(['a', 'b', 'c'])
   *   })
   * })
   *
   * if (choice.action === 'accept') {
   *   console.log('User chose:', choice.content.option)
   * }
   * ```
   */
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>>

  // ---------------------------------------------------------------------------
  // Sub-branches
  // ---------------------------------------------------------------------------

  /**
   * Spawn a sub-branch for structured concurrency.
   *
   * Sub-branches:
   * - Run server-side (not a separate MCP call)
   * - Can sample/elicit/branch themselves
   * - Reduce back to a single value
   *
   * For concurrent branches, use Effection's `all()`:
   * ```typescript
   * const [a, b] = yield* all([
   *   ctx.branch(branchA),
   *   ctx.branch(branchB),
   * ])
   * ```
   *
   * @example Sequential branches
   * ```typescript
   * const first = yield* ctx.branch(function* (subCtx) {
   *   return yield* subCtx.sample({ prompt: 'First task...' })
   * })
   *
   * const second = yield* ctx.branch(function* (subCtx) {
   *   return yield* subCtx.sample({ prompt: `Based on ${first}...` })
   * })
   * ```
   *
   * @example With options
   * ```typescript
   * const isolated = yield* ctx.branch(function* (subCtx) {
   *   // Fresh context, no parent messages
   *   return yield* subCtx.sample({ prompt: 'Independent task...' })
   * }, {
   *   inheritMessages: false,
   *   maxDepth: 2,
   *   timeout: 5000
   * })
   * ```
   */
  branch<T>(
    fn: (ctx: BranchContext) => Operation<T>,
    options?: BranchOptions
  ): Operation<T>

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  /**
   * Send a log message to the client.
   *
   * Maps to MCP: `notifications/message`
   */
  log(level: LogLevel, message: string): Operation<void>

  /**
   * Send a progress notification to the client.
   *
   * Maps to MCP: `notifications/progress`
   */
  notify(message: string, progress?: number): Operation<void>
}

// =============================================================================
// BRANCH HANDOFF CONFIGURATION
// =============================================================================

/**
 * Configuration for a tool with branch-based handoff pattern.
 *
 * Type flow:
 * ```
 * TParams --> before(params, ctx) --> THandoff
 *                                        |
 *         +------------------------------+
 *         v                              v
 * client(handoff, ctx) --> TClient
 *         |                              |
 *         +--------> after(handoff, client, ctx, params) --> TResult
 * ```
 *
 * @template TParams - Tool parameters from LLM
 * @template THandoff - Data from before() to client() and after()
 * @template TClient - Data from client() to after()
 * @template TResult - Final result returned to LLM
 */
export interface BranchHandoffConfig<TParams, THandoff, TClient, TResult> {
  /**
   * Phase 1: Server-side setup (runs ONCE).
   *
   * Put expensive computations, database lookups, random selections,
   * or any non-idempotent code here. The return value is:
   * 1. Passed to client() as handoff data
   * 2. Cached and passed to after() (NOT re-computed)
   */
  before: (params: TParams, ctx: BranchServerContext) => Operation<THandoff>

  /**
   * Client phase: Branch-based multi-turn interaction.
   *
   * This is where you use ctx.sample(), ctx.elicit(), and ctx.branch()
   * for complex multi-turn conversations with the LLM and user.
   */
  client: (handoff: THandoff, ctx: BranchContext) => Operation<TClient>

  /**
   * Phase 2: Server-side finalization (runs ONCE after client).
   *
   * Receives:
   * - handoff: Cached data from before() (NOT re-computed)
   * - client: Response from client()
   *
   * Returns the final result that goes to the LLM.
   */
  after: (
    handoff: THandoff,
    client: TClient,
    ctx: BranchServerContext,
    params: TParams
  ) => Operation<TResult>
}

/**
 * Server context for before() and after() phases.
 */
export interface BranchServerContext {
  /** Unique identifier for this tool call */
  callId: string

  /** Abort signal for cancellation */
  signal: AbortSignal
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error thrown when branch depth limit is exceeded.
 */
export class BranchDepthError extends Error {
  constructor(
    public readonly depth: number,
    public readonly maxDepth: number
  ) {
    super(`Branch depth ${depth} exceeds maximum ${maxDepth}`)
    this.name = 'BranchDepthError'
  }
}

/**
 * Error thrown when branch token budget is exceeded.
 */
export class BranchTokenError extends Error {
  constructor(
    public readonly used: number,
    public readonly budget: number
  ) {
    super(`Branch used ${used} tokens, exceeding budget of ${budget}`)
    this.name = 'BranchTokenError'
  }
}

/**
 * Error thrown when branch times out.
 */
export class BranchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Branch timed out after ${timeoutMs}ms`)
    this.name = 'BranchTimeoutError'
  }
}
