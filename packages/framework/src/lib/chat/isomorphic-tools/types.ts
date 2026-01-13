/**
 * Isomorphic Tool Types
 *
 * Isomorphic tools execute code on both server AND client. The key principle:
 *
 * **SERVER'S RETURN VALUE IS ALWAYS THE FINAL RESULT SENT TO THE LLM.**
 *
 * There is no "merge" function. The server has the final say.
 *
 * ## Authority Modes
 *
 * ### Client Authority
 * Client executes first, then server validates/processes. Common for user input.
 *
 * ```
 * LLM calls: ask_question({ question: "Is it alive?" })
 *     │
 *     ▼
 * Server: Immediately hands off to client (no server code yet)
 *     │
 *     ▼
 * Client: tool.client(params, ctx) runs
 *     ├── Shows modal with "Is it alive?"
 *     ├── User clicks "Yes"
 *     └── Returns: { question: "Is it alive?", answer: true }
 *     │
 *     ▼
 * Server: tool.server(params, ctx, clientOutput) runs
 *     ├── Updates game state
 *     └── Returns: { success: true, answer: true, questionCount: 1, remaining: 19 }
 *     │
 *     ▼
 * LLM receives server's return value as tool result
 * ```
 *
 * ### Server Authority
 * Server executes first, yields to client, then continues. Common for server-side
 * state that needs client-side presentation.
 *
 * ```
 * LLM calls: celebrate({ winner: "user" })
 *     │
 *     ▼
 * Server: tool.server(params, ctx) starts
 *     ├── Validates game state
 *     ├── Yields to client: yield* ctx.handoff({ confetti: true, message: "You win!" })
 *     │
 *     ▼
 * Client: tool.client(handoffData, ctx) runs
 *     ├── Shows confetti animation
 *     └── Returns: { acknowledged: true }
 *     │
 *     ▼
 * Server: Continuation resumes with clientResult
 *     └── Returns: { celebrated: true, userSaw: true }
 *     │
 *     ▼
 * LLM receives server's return value as tool result
 * ```
 *
 * ## Key Design Goals
 * 1. Type safety: Proper typing for data flowing between server and client
 * 2. Effection generators: Both sides use `function*`
 * 3. Server authority over LLM results: Server always returns the final value
 * 4. Ergonomic single-file definition (like TanStack Start's isomorphic fns)
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type { ApprovalType, DenialBehavior } from './runtime/tool-runtime.ts'
import type { ContextMode, BaseToolContext } from './contexts.ts'

// --- Authority Modes ---

/**
 * Determines execution order and data flow.
 *
 * - `client`: Client executes first → output flows to server → server returns final result
 * - `server`: Server executes → can yield to client → server returns final result
 */
export type AuthorityMode = 'server' | 'client'

// --- Approval Configuration ---

/**
 * Approval settings for isomorphic tools.
 */
export interface IsomorphicApprovalConfig {
  /**
   * Server-side approval type.
   * @default 'none'
   */
  server?: ApprovalType

  /**
   * Client-side approval type.
   * @default 'confirm'
   */
  client?: ApprovalType

  /**
   * Message shown for client approval.
   * Can be static or generated from params.
   */
  clientMessage?: string | ((params: unknown) => string)

  /**
   * What happens if client denies.
   * @default 'error'
   */
  onDenied?: DenialBehavior
}

// --- Handoff Configuration (V7 API) ---

/**
 * Configuration for a server-authority handoff.
 *
 * The V7 handoff pattern allows server-authority tools to:
 * 1. Execute expensive/non-idempotent code in `before()` (phase 1 only)
 * 2. Halt and send data to client
 * 3. Resume with client response in `after()` (phase 2 only)
 *
 * Key guarantee: `before()` only runs once, even though the server operation
 * is re-executed in phase 2. The executor skips `before()` and uses cached data.
 *
 * @template THandoff - Data sent to client (and cached for phase 2)
 * @template TClient - Data received from client
 * @template TResult - Final result returned to LLM
 */
export interface HandoffConfig<THandoff, TClient, TResult> {
  /**
   * Executed in phase 1 only.
   *
   * Put expensive computations, random selections, or any non-idempotent
   * code here. The return value is:
   * 1. Sent to the client as handoff data
   * 2. Cached and passed to `after()` in phase 2
   */
  before: () => Operation<THandoff>

  /**
   * Executed in phase 2 only (after client responds).
   *
   * Receives:
   * - `handoff`: The cached data from `before()` (NOT re-computed)
   * - `client`: The response from the client
   *
   * Returns the final result that goes to the LLM.
   */
  after: (handoff: THandoff, client: TClient) => Operation<TResult>
}

// --- Re-export context types from contexts.ts ---

export type {
  ContextMode,
  BaseToolContext,
  BrowserToolContext,
  AgentToolContext,
  PromptOptions,
  ContextForMode,
  AnyToolContext,
  ApprovalResult,
  PermissionType,
} from './contexts.ts'

export { canRunIn, validateContextMode } from './contexts.ts'

// --- Server Context ---

/**
 * Context passed to server-side execution.
 */
export interface ServerToolContext {
  /**
   * Unique ID of this tool call.
   */
  callId: string

  /**
   * Abort signal for cancellation.
   */
  signal: AbortSignal
}

/**
 * Extended server context for server-authority tools with handoff capability.
 *
 * This context is passed to server-authority tools and includes the `handoff()`
 * method for yielding to the client mid-execution.
 */
export interface ServerAuthorityContext extends ServerToolContext {
  handoff: <THandoff, TClient, TResult>(
    config: HandoffConfig<THandoff, TClient, TResult>
  ) => Operation<TResult>
}

// --- Isomorphic Tool Definition ---

/**
 * Definition of an isomorphic tool.
 *
 * @template TParams - Zod schema for parameters (from LLM)
 * @template TServerOutput - Return type of server execution (this goes to LLM!)
 * @template TClientOutput - Return type of client execution
 *
 * The type relationships depend on authority:
 * - `client` authority: Client receives params, server receives clientOutput
 * - `server` authority: Server can yield to client via handoff

 *
 * **Important**: TServerOutput is always what the LLM receives as the tool result.
 */
export interface IsomorphicToolDef<
  TParams extends z.ZodType = z.ZodType,
  TServerOutput = unknown,
  TClientOutput = unknown,
> {
  /** Unique name for the tool (used by LLM to invoke it) */
  name: string

  /** Description shown to LLM to help it understand when to use this tool */
  description: string

  /** Zod schema for tool parameters (validated on server) */
  parameters: TParams

  /**
   * Which side has authority (executes first).
   * @default 'server'
   */
  authority?: AuthorityMode

  /**
   * Approval configuration.
   */
  approval?: IsomorphicApprovalConfig

  /**
   * Server-side execution.
   *
   * For `client` authority: Receives params + clientOutput for processing.
   * For `server` authority: Executes first, may yield to client via ctx.handoff().
   *
   * **The return value of this function is sent to the LLM as the tool result.**
   *
   * Note: For server-authority tools, the context will be ServerAuthorityContext
   * which includes the handoff() method. The generic type uses the base
   * ServerToolContext for compatibility across all authority modes.
   */
  server?: (
    params: z.infer<TParams>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: any, // ServerToolContext or ServerAuthorityContext depending on authority
    /**
     * For `client` authority: Output from client execution.
     * For other modes: undefined.
     */
    clientOutput?: TClientOutput
  ) => Operation<TServerOutput>

  /**
   * Client-side execution.
   *
   * For `client` authority: Receives params from LLM, returns output for server.
   * For `server` authority: Receives handoff data from server.
   */
  client?: (
    /**
     * For `client` authority: Original params from LLM.
     * For `server` authority: Handoff data from server.

     */
    input: TServerOutput | z.infer<TParams>,
    context: BaseToolContext,
    /**
     * Original params from LLM (always available).
     */
    params: z.infer<TParams>
  ) => Operation<TClientOutput>
}

// --- Strongly Typed Variants ---

/**
 * Base properties shared by all isomorphic tools.
 */
interface IsomorphicToolBase<TParams extends z.ZodType> {
  name: string
  description: string
  parameters: TParams
  approval?: IsomorphicApprovalConfig
}

/**
 * Client-authority tool: Client executes first, server validates/processes.
 *
 * Flow:
 * 1. Client receives params, returns clientOutput
 * 2. Server receives params + clientOutput, returns serverOutput
 * 3. LLM receives serverOutput
 */
export type ClientAuthorityToolDef<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
> = IsomorphicToolBase<TParams> & {
  authority: 'client'

  /** Client executes first with params */
  client: (
    params: z.infer<TParams>,
    context: BaseToolContext,
    originalParams: z.infer<TParams>
  ) => Operation<TClientOutput>

  /** Server receives client output, returns final result for LLM */
  server: (
    params: z.infer<TParams>,
    context: ServerToolContext,
    clientOutput: TClientOutput
  ) => Operation<TServerOutput>
}

/**
 * Server-authority tool: Server executes, optionally yields to client via handoff.
 *
 * Flow (simple - no handoff):
 * 1. Server receives params, returns serverOutput immediately
 * 2. Client receives serverOutput for side effects
 * 3. LLM receives serverOutput
 *
 * Flow (with handoff):
 * 1. Server receives params, calls ctx.handoff({ before, after })
 * 2. before() runs, returns handoff data, server halts (phase 1)
 * 3. Client receives handoff data, returns clientOutput
 * 4. Server resumes, after() runs with cached handoff + clientOutput (phase 2)
 * 5. LLM receives after()'s return value
 */
export type ServerAuthorityToolDef<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
> = IsomorphicToolBase<TParams> & {
  authority: 'server'

  /**
   * Server executes first with params.
   *
   * For simple tools: Just return the result directly.
   * For handoff tools: Use ctx.handoff({ before, after }) to yield to client.
   */
  server: (
    params: z.infer<TParams>,
    context: ServerAuthorityContext
  ) => Operation<TServerOutput>

  /** Client receives server handoff data (or full serverOutput if no handoff) */
  client: (
    serverOutput: TServerOutput,
    context: BaseToolContext,
    params: z.infer<TParams>
  ) => Operation<TClientOutput>
}

/**
 * Parallel tool: Both execute concurrently with same params.
 *
 * Flow:
 * 1. Server and client both execute with params concurrently
 * 2. LLM receives serverOutput (client output is for side effects only)
 */

// --- Helper Types ---

/**
 * Any isomorphic tool (for arrays/registries/executor).
 *
 * This is intentionally "erased" and uses method signatures so that both:
 * - object-defined tools (see `defineIsomorphicTool`)
 * - builder tools (see `createIsomorphicTool`)
 *
 * can be used without `as any` casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AnyIsomorphicTool {
  name: string
  description: string
  parameters: z.ZodTypeAny
  authority?: AuthorityMode
  approval?: IsomorphicApprovalConfig

  server?(params: any, context: any, clientOutput?: any): Operation<any>
  client?(input: any, context: BaseToolContext, params: any): Operation<any>
  
  /** Execution context mode (required for new tools, optional for legacy) */
  contextMode?: ContextMode
}

/**
 * Extract the params type from an isomorphic tool.
 */
export type IsomorphicToolParams<T extends AnyIsomorphicTool> = z.infer<T['parameters']>

/**
 * Extract the server output type from an isomorphic tool.
 */
export type IsomorphicToolServerOutput<T extends AnyIsomorphicTool> =
  T extends IsomorphicToolDef<z.ZodType, infer S, unknown> ? S : unknown

/**
 * Extract the client output type from an isomorphic tool.
 */
export type IsomorphicToolClientOutput<T extends AnyIsomorphicTool> =
  T extends IsomorphicToolDef<z.ZodType, unknown, infer C> ? C : unknown

// --- Stream Events ---

/**
 * Special error thrown to halt execution at handoff point.
 *
 * This is an internal mechanism used by the V7 handoff pattern.
 * When `before()` completes, we throw this error to halt execution
 * and capture the handoff data for sending to the client.
 */
export class HandoffReadyError<T> extends Error {
  constructor(public readonly handoffData: T) {
    super('HandoffReady')
    this.name = 'HandoffReadyError'
  }
}

/**
 * Event emitted when server hands off to client.
 *
 * Sent via SSE/NDJSON to the client session.
 */
export interface IsomorphicHandoffEvent {
  type: 'isomorphic_handoff'
  callId: string
  toolName: string
  params: unknown
  /**
   * For simple server-authority: The full serverOutput.
   * For handoff tools: The data from before() (handoff data).
   */
  serverOutput: unknown
  authority: AuthorityMode
  /**
   * Indicates this handoff uses the V7 two-phase pattern.
   * If true, the server needs to be re-run in phase 2 with clientOutput.
   */
  usesHandoff?: boolean
}

/**
 * Event emitted when client completes.
 *
 * For `client` authority: Sent back to server for processing.
 */
export interface IsomorphicClientCompleteEvent {
  type: 'isomorphic_client_complete'
  callId: string
  toolName: string
  clientOutput: unknown
}

/**
 * Result of isomorphic tool execution.
 *
 * The `content` field contains the serialized serverOutput, which is what
 * gets sent to the LLM as the tool result.
 */
export interface IsomorphicToolResult {
  callId: string
  toolName: string
  ok: boolean
  /** Serialized server output (this is what the LLM sees) */
  content?: string
  error?: string
  serverOutput?: unknown
  clientOutput?: unknown
}

// --- Registry Types ---

/**
 * Registry of isomorphic tools.
 */
export interface IsomorphicToolRegistry {
  /** All registered tools */
  tools: Map<string, AnyIsomorphicTool>

  /** Get a tool by name */
  get(name: string): AnyIsomorphicTool | undefined

  /** Check if a tool exists */
  has(name: string): boolean

  /** Get all tool names */
  names(): string[]

  /**
   * Get server-only tool definitions (for server registry).
   * Extracts just the server execution part.
   */
  toServerTools(): ServerOnlyToolDef[]

  /**
   * Get client tool schemas (for sending to server).
   * These are the schemas the LLM sees.
   */
  toToolSchemas(): IsomorphicToolSchema[]
}

/**
 * Minimal server-side tool definition (for internal use).
 */
export interface ServerOnlyToolDef {
  name: string
  description: string
  parameters: z.ZodType
  authority: AuthorityMode
  execute: (
    params: unknown,
    context: ServerToolContext,
    clientOutput?: unknown
  ) => Operation<unknown>
}

/**
 * Tool schema sent to LLM.
 */
export interface IsomorphicToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  isIsomorphic: true
  authority: AuthorityMode
}

// --- Execution State ---

/**
 * State of an isomorphic tool during execution.
 */
export type IsomorphicToolState =
  | 'pending'
  | 'server_executing'
  | 'awaiting_client_approval'
  | 'client_executing'
  | 'server_validating' // For client-authority mode
  | 'complete'
  | 'error'
  | 'denied'

/**
 * Pending isomorphic tool (exposed to React).
 */
export interface PendingIsomorphicTool {
  /** Tool call ID */
  id: string

  /** Tool name */
  name: string

  /** Parsed arguments */
  arguments: Record<string, unknown>

  /** Current state */
  state: IsomorphicToolState

  /** Authority mode */
  authority: AuthorityMode

  /** Server output (if available) */
  serverOutput?: unknown

  /** Client output (if available) */
  clientOutput?: unknown

  /** Final result sent to LLM (serialized serverOutput) */
  result?: string

  /** Error message (if failed) */
  error?: string

  /** Approval message (if awaiting) */
  approvalMessage?: string

  /** Approve client execution */
  approve(): void

  /** Deny client execution */
  deny(reason?: string): void
}
