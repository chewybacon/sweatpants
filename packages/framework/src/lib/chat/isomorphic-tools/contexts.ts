/**
 * Tool Context Types
 *
 * Declarative context types for isomorphic tools. Each tool declares what
 * execution context it requires, and the type system enforces it.
 *
 * ## Context Hierarchy
 *
 * ```
 * BaseToolContext (headless - pure computation)
 *   ├── BrowserToolContext (+ waitFor for UI)
 *   └── AgentToolContext (+ prompt for LLM)
 * ```
 *
 * ## Least Privilege Principle
 *
 * - Tools that only use `BaseToolContext` can run anywhere
 * - Tools that use `BrowserToolContext` require browser/UI environment
 * - Tools that use `AgentToolContext` require server-side agent environment
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'

// =============================================================================
// CONTEXT MODES
// =============================================================================

/**
 * Execution context mode for a tool.
 *
 * - `headless`: Pure computation, no UI or LLM - can run anywhere
 * - `browser`: Requires UI interaction via waitFor
 * - `agent`: Requires LLM access via prompt
 */
export type ContextMode = 'headless' | 'browser' | 'agent'

// =============================================================================
// APPROVAL TYPES (shared across all contexts)
// =============================================================================

/**
 * Result of an approval request.
 */
export type ApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string }

/**
 * Browser permission types that can be requested.
 */
export type PermissionType =
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | (string & {})

// =============================================================================
// BASE CONTEXT (headless - can run anywhere)
// =============================================================================

/**
 * Base context available to all tools regardless of execution environment.
 *
 * Tools that only use BaseToolContext can run in any environment:
 * browser, server agent, or headless.
 */
export interface BaseToolContext {
  /** Unique identifier for this tool call */
  callId: string

  /** Abort signal for cancellation */
  signal: AbortSignal

  /**
   * Request user approval before proceeding.
   * In agent mode, this auto-approves.
   */
  requestApproval(message: string): Operation<ApprovalResult>

  /**
   * Request browser permission.
   * In agent mode, this auto-approves.
   */
  requestPermission(type: PermissionType): Operation<ApprovalResult>

  /**
   * Report progress to the UI.
   * In agent mode, this may emit a progress event.
   */
  reportProgress(message: string): Operation<void>
}

// =============================================================================
// BROWSER CONTEXT (requires UI)
// =============================================================================

/**
 * Context for tools that require browser/UI interaction.
 *
 * Extends BaseToolContext with `waitFor` for suspending execution
 * and waiting for user input via UI components.
 */
export interface BrowserToolContext extends BaseToolContext {
  /**
   * Suspend execution and wait for UI input.
   *
   * The type string routes to a registered UI handler that renders
   * the appropriate component and returns the user's response.
   *
   * @param type - Handler type (e.g., 'select-choice', 'confirm')
   * @param payload - Data the UI handler needs to render
   * @returns Response from the UI handler
   *
   * @example
   * ```typescript
   * const response = yield* ctx.waitFor('select-choice', {
   *   choices: ['A', 'B', 'C'],
   *   prompt: 'Pick one',
   * })
   * // response: { selected: 'B' }
   * ```
   */
  waitFor<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

// =============================================================================
// AGENT CONTEXT (requires LLM)
// =============================================================================

/**
 * Options for a structured LLM prompt.
 */
export interface PromptOptions<T extends z.ZodType> {
  /** The prompt text to send to the LLM */
  prompt: string

  /** Zod schema for structured output */
  schema: T

  /** Optional system prompt */
  system?: string

  /** Optional model override */
  model?: string

  /** Optional temperature (0-1) */
  temperature?: number
}

/**
 * Context for tools that require server-side LLM access.
 *
 * Extends BaseToolContext with `prompt` for making structured LLM calls.
 * Only available when running as a server-side agent.
 */
export interface AgentToolContext extends BaseToolContext {
  /**
   * Execute a structured LLM prompt.
   *
   * Sends a prompt to the LLM and parses the response against
   * the provided Zod schema.
   *
   * @param opts - Prompt options including text and schema
   * @returns Parsed and validated response
   *
   * @example
   * ```typescript
   * const result = yield* ctx.prompt({
   *   prompt: 'Analyze the sentiment of: "Great product!"',
   *   schema: z.object({
   *     sentiment: z.enum(['positive', 'negative', 'neutral']),
   *     confidence: z.number(),
   *   }),
   * })
   * // result: { sentiment: 'positive', confidence: 0.95 }
   * ```
   */
  prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>>

  /**
   * Emit an event to the parent orchestrator.
   *
   * Use for streaming progress, intermediate results, or status updates.
   * Optional - may not be available in all agent configurations.
   */
  emit?: ((event: unknown) => Operation<void>) | undefined
}

// =============================================================================
// TYPE UTILITIES
// =============================================================================

/**
 * Map a context mode to its corresponding context type.
 *
 * @example
 * ```typescript
 * type Ctx = ContextForMode<'agent'>  // AgentToolContext
 * type Ctx = ContextForMode<'browser'>  // BrowserToolContext
 * type Ctx = ContextForMode<'headless'>  // BaseToolContext
 * ```
 */
export type ContextForMode<TMode extends ContextMode> =
  TMode extends 'agent' ? AgentToolContext :
  TMode extends 'browser' ? BrowserToolContext :
  BaseToolContext

/**
 * Union of all possible context types.
 */
export type AnyToolContext = BaseToolContext | BrowserToolContext | AgentToolContext

// =============================================================================
// CONTEXT MODE COMPATIBILITY
// =============================================================================

/**
 * Check if a context mode can run in a given environment.
 *
 * Least privilege: headless tools can run anywhere.
 *
 * @example
 * ```typescript
 * canRunIn('headless', 'browser')  // true - headless runs anywhere
 * canRunIn('browser', 'agent')     // false - browser needs UI
 * canRunIn('agent', 'agent')       // true - exact match
 * ```
 */
export function canRunIn(
  toolMode: ContextMode,
  environmentMode: ContextMode
): boolean {
  // Headless tools can run anywhere
  if (toolMode === 'headless') return true

  // Otherwise must match exactly
  return toolMode === environmentMode
}

/**
 * Validate that a tool can run in the given environment.
 * Throws if incompatible.
 */
export function validateContextMode(
  toolName: string,
  toolMode: ContextMode,
  environmentMode: ContextMode
): void {
  if (!canRunIn(toolMode, environmentMode)) {
    throw new Error(
      `Tool "${toolName}" requires '${toolMode}' context but environment provides '${environmentMode}'. ` +
      (toolMode === 'browser'
        ? 'Browser tools need UI interaction via waitFor().'
        : toolMode === 'agent'
        ? 'Agent tools need LLM access via prompt().'
        : '')
    )
  }
}
