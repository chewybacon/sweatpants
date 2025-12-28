import type { Operation, Channel } from 'effection'
import type { IsomorphicHandoffEvent } from '../../lib/chat/types'
import type { Message } from '../../handler/types'
export { groupTimelineByToolCall } from '../../lib/chat/isomorphic-tools/runtime/types'

// --- Stream Result Types ---

/**
 * Result of a streaming chat request.
 * 
 * Either the request completed normally, or the server is handing off
 * to the client for tool execution.
 */
export type StreamResult = 
  | StreamCompleteResult
  | StreamIsomorphicHandoffResult

/**
 * Normal completion - assistant finished responding.
 */
export interface StreamCompleteResult {
  type: 'complete'
  /** Final assistant text content */
  text: string
}


/**
 * Server has executed isomorphic tool server parts and is handing off
 * to client for client-side execution.
 * 
 * The client should:
 * 1. Execute the client parts of each isomorphic tool
 * 2. Re-initiate the request with merged results
 */
export interface StreamIsomorphicHandoffResult {
  type: 'isomorphic_handoff'
  /** Handoff events from server (one per isomorphic tool call) */
  handoffs: IsomorphicHandoffEvent[]
  /** Conversation state for re-initiation */
  conversationState: ConversationState
}

// --- Streamer Type (for dependency injection in tests) ---

/** Message format for API requests (matches OllamaMessage) */
export interface ApiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Tool calls made by the assistant */
  tool_calls?: Array<{
    id: string
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  /** For tool role: the ID of the tool call this is responding to */
  tool_call_id?: string
}

/**
 * A streamer is an Operation that performs a streaming chat request.
 *
 * This abstraction allows us to swap out the real fetch-based streamer
 * for a test streamer that we can control step-by-step.
 *
 * @param messages - The conversation history
 * @param patches - Channel to emit patches to
 * @param options - Session options (without streamer to avoid circular ref)
  * @returns StreamResult - either complete or isomorphic_handoff
 */
export type Streamer = (
  messages: ApiMessage[],
  patches: Channel<ChatPatch, void>,
  options: Omit<SessionOptions, 'streamer'>
) => Operation<StreamResult>

// --- Settler Types (for dual buffer) ---

/**
 * Context passed to a settler function.
 * 
 * The settler uses this to decide what content (if any) should settle.
 */
export interface SettleContext {
  /** Current pending buffer (content not yet settled) */
  pending: string
  /** Milliseconds since pending started accumulating */
  elapsed: number
  /** Already settled content (for context, e.g., detecting code blocks) */
  settled: string
  /** The patch that triggered this settle check */
  patch: ChatPatch
  /** 
   * True when this is the final flush at stream end.
   * 
   * Settlers should settle ALL remaining content, even incomplete lines.
   * For code fence settlers, this means:
   * - Treating ``` without trailing newline as a valid fence close
   * - Settling any remaining content inside an unclosed fence
   */
  flush?: boolean
}

/**
 * Metadata that settlers can attach to settled content.
 * 
 * This allows processors to know context about what they're processing,
 * e.g., whether content is inside a code fence and what language it is.
 */
export interface SettleMeta {
  /** Whether this content is inside a code fence */
  inCodeFence?: boolean
  /** The language of the code fence (e.g., 'python', 'typescript') */
  language?: string
  /** Allow additional metadata fields */
  [key: string]: unknown
}

/**
 * Result yielded by a settler - content plus optional metadata.
 * 
 * The metadata allows settlers to communicate context to processors,
 * enabling smart processing like syntax highlighting for code fences.
 */
export interface SettleResult {
  /** The content to settle (must be a prefix of pending) */
  content: string
  /** Optional metadata about this content */
  meta?: SettleMeta
}

/**
 * A settler decides when and what content should move from pending to settled.
 * 
 * Instead of returning a boolean (when) and having the buffer decide (what),
 * the settler yields the actual content to settle. This elegantly combines
 * "when" and "what" into a single concept.
 * 
 * ## Examples
 * 
 * ```typescript
 * // Timeout: settle everything after 150ms
 * function* timeoutSettler({ pending, elapsed }) {
 *   if (elapsed >= 150) {
 *     yield pending
 *   }
 * }
 * 
 * // Paragraph: settle up to each \n\n
 * function* paragraphSettler({ pending }) {
 *   const idx = pending.indexOf('\n\n')
 *   if (idx !== -1) {
 *     yield pending.slice(0, idx + 2)
 *   }
 * }
 * 
 * // Simple style - return an array
 * const maxSizeSettler = ({ pending }) => 
 *   pending.length > 500 ? [pending] : []
 * ```
 * 
 * ## Rules
 * 
 * 1. Yielded content MUST be a prefix of `pending`
 * 2. Yield multiple times to settle in chunks
 * 3. Yield nothing to leave everything in pending
 * 4. The sum of yielded content is removed from pending
 */
export type Settler = (ctx: SettleContext) => Iterable<string>

/**
 * A metadata-aware settler that yields SettleResult objects with optional metadata.
 * 
 * Use this for settlers that need to communicate context to processors,
 * like code fence detection for syntax highlighting.
 * 
 * ## Example
 * 
 * ```typescript
 * // Code fence aware settler
 * function codeFence(): MetadataSettler {
 *   let inFence = false
 *   let language = ''
 *   
 *   return function* (ctx) {
 *     // ... detect fence open/close ...
 *     yield { 
 *       content: line, 
 *       meta: { inCodeFence: true, language: 'python' } 
 *     }
 *   }
 * }
 * ```
 */
export type MetadataSettler = (ctx: SettleContext) => Iterable<SettleResult>

/**
 * A factory function that creates a fresh Settler instance.
 * 
 * Stateful settlers (like codeFence) track state across calls that must be
 * reset between streaming sessions. By passing a factory to dualBufferTransform,
 * a fresh settler is created on each `streaming_start` event.
 * 
 * @example
 * ```typescript
 * // Pass the factory function, NOT a called instance
 * dualBufferTransform({
 *   settler: codeFence,  // factory reference
 * })
 * 
 * // NOT this (creates a single instance that accumulates state):
 * dualBufferTransform({
 *   settler: codeFence(),  // instance - BAD!
 * })
 * ```
 */
export type SettlerFactory = () => Settler | MetadataSettler

// --- Processor Types (for enriching settled content) ---

/**
 * Output from a processor - the enriched settled content.
 * 
 * Processors can add arbitrary fields that will be spread onto
 * the buffer_settled patch. Common fields:
 * - `html`: Parsed HTML (from markdown processor)
 * - `ast`: Parsed AST (for syntax highlighting, etc.)
 * - `pass`: For progressive enhancement ('quick' | 'full')
 * 
 * The base `raw` field contains the original settled content.
 */
export interface ProcessedOutput {
  /** The raw settled content (always present) */
  raw: string
  /** Parsed HTML, if a markdown processor ran */
  html?: string
  /** Parsed AST, for advanced processing */
  ast?: unknown
  /** Progressive enhancement pass indicator */
  pass?: 'quick' | 'full'
  /** Allow additional fields for extensibility */
  [key: string]: unknown
}

/**
 * Context passed to a processor function.
 */
export interface ProcessorContext {
  /** The chunk of content being settled right now */
  chunk: string
  /** All previously settled content (for parsing context) */
  accumulated: string
  /** The full content after this chunk settles (accumulated + chunk) */
  next: string
  /** Metadata from the settler (e.g., code fence info) */
  meta?: SettleMeta
}

/**
 * Emitter for processors to emit enriched output.
 * 
 * Returns an Operation so processors must yield* to emit:
 * ```typescript
 * yield* emit({ raw, html: quickHighlight(raw), pass: 'quick' })
 * const fullHtml = yield* highlightCode(...)
 * yield* emit({ raw, html: fullHtml, pass: 'full' })
 * ```
 * 
 * This enables true progressive enhancement - the quick pass is
 * sent to the client immediately, before the async work completes.
 */
export type ProcessorEmit = (output: ProcessedOutput) => Operation<void>

/**
 * A processor transforms settled content, adding enrichments like parsed HTML or AST.
 * 
 * Processors are Effection Operations that can:
 * - Do async work (yield* sleep(), yield* call())
 * - Emit multiple times for progressive enhancement (yield* emit(...))
 * - Access settler metadata for context-aware processing
 * 
 * ## Examples
 * 
 * ```typescript
 * // Passthrough - no processing
 * function passthrough(): Processor {
 *   return function* (ctx, emit) {
 *     yield* emit({ raw: ctx.chunk })
 *   }
 * }
 * 
 * // Markdown - parse to HTML
 * function markdown(): Processor {
 *   return function* (ctx, emit) {
 *     const html = marked.parse(ctx.next)
 *     yield* emit({ raw: ctx.next, html })
 *   }
 * }
 * 
 * // Progressive syntax highlighting
 * function syntaxHighlight(): Processor {
 *   return function* (ctx, emit) {
 *     // Quick pass - instant regex highlighting (sent immediately!)
 *     yield* emit({ raw: ctx.chunk, html: quickHighlight(ctx.chunk), pass: 'quick' })
 *     
 *     // Full pass - async Shiki highlighting
 *     const html = yield* highlightCode(ctx.chunk, ctx.meta?.language)
 *     yield* emit({ raw: ctx.chunk, html, pass: 'full' })
 *   }
 * }
 * ```
 */
export type Processor = (ctx: ProcessorContext, emit: ProcessorEmit) => Operation<void>

/**
 * A factory function that creates a fresh Processor instance.
 * 
 * Processors maintain state (e.g., accumulated HTML) that must be reset
 * between streaming sessions. By passing a factory to dualBufferTransform,
 * a fresh processor is created on each `streaming_start` event.
 * 
 * @example
 * ```typescript
 * // Pass the factory function, NOT a called instance
 * dualBufferTransform({
 *   processor: shikiProcessor,  // factory reference
 * })
 * 
 * // NOT this (creates a single instance that accumulates state):
 * dualBufferTransform({
 *   processor: shikiProcessor(),  // instance - BAD!
 * })
 * ```
 */
/**
 * A processor factory creates fresh processor instances.
 * Processors maintain state and must be recreated per streaming session.
 */
export type ProcessorFactory = () => Processor

/**
 * A chain of processors that run in sequence.
 * Each processor receives the output of the previous as input.
 */
export type ProcessorChain = ProcessorFactory | ProcessorFactory[]

/**
 * Legacy sync processor for simple use cases.
 * 
 * @deprecated Use the async Processor type for new code.
 */
export type SyncProcessor = (ctx: ProcessorContext) => ProcessedOutput

// --- Transform Types ---

/**
 * A patch transform is an Effection operation that reads patches from
 * an input channel, transforms them, and writes to an output channel.
 *
 * Transforms can:
 * - Buffer/debounce patches (e.g., wait for complete markdown chunks)
 * - Enrich patches with additional data (e.g., parsed AST)
 * - Filter patches
 * - Emit multiple output patches for one input
 *
 * The transform MUST consume all input and close when input closes.
 */
export type PatchTransform = (
  input: Channel<ChatPatch, void>,
  output: Channel<ChatPatch, void>
) => Operation<void>

// --- Message Renderer ---

/**
 * A message renderer transforms message content to HTML.
 * 
 * Used for rendering completed messages (both user and assistant).
 * This is simpler than the streaming processor - just a sync function.
 * 
 * @param content - The raw message content
 * @returns HTML string, or undefined to skip rendering
 */
export type MessageRenderer = (content: string) => string | undefined

// Session Configuration
export interface SessionOptions {
  /**
   * Base URL for the chat API.
   * 
   * Defaults to '/api/chat'. Use this to point to a different server
   * or when the API is mounted at a different path.
   * 
   * @example
   * ```typescript
   * // Local development with different port
   * useChatSession({ baseUrl: 'http://localhost:4000/api/chat' })
   * 
   * // Production API
   * useChatSession({ baseUrl: 'https://api.example.com/chat' })
   * ```
   */
  baseUrl?: string

  // Manual mode
  enabledTools?: string[] | boolean
  
  /**
   * System prompt for manual mode.
   * 
   * This is prepended to messages as a system message.
   * Only used when `persona` is not set.
   */
  systemPrompt?: string

  // Persona mode (mutually exclusive with enabledTools)
  persona?: string
  personaConfig?: Record<string, boolean | number | string>
  enableOptionalTools?: string[]
  effort?: 'auto' | 'low' | 'medium' | 'high'

  // Stream transforms - process patches before they reach React state
  transforms?: PatchTransform[]

  /**
   * Renderer for completed messages.
   * 
   * Applied to both user and assistant messages when they're finalized.
   * The rendered HTML is stored in `state.rendered[messageId]`.
   * 
   * If not provided, messages are not rendered (raw content only).
   * 
   * @example
   * ```typescript
   * import { marked } from 'marked'
   * 
   * useChatSession({
   *   renderer: (content) => marked.parse(content, { async: false }) as string,
   * })
   * ```
   */
  renderer?: MessageRenderer

  /**
   * Custom streamer for dependency injection (primarily for testing).
   * 
   * If not provided, uses the default fetch-based streamChatOnce.
   * 
   * @example
   * ```typescript
   * // In tests:
   * const { streamer, controls } = createTestStreamer()
   * useChatSession({ streamer })
   * ```
   */
  streamer?: Streamer

  /**
   * Whether to preserve partial responses when the user aborts.
   * If true, the streamed content up to the abort is saved as an assistant message.
   * @default true
   */
  preservePartialOnAbort?: boolean

  /**
   * Suffix to append to aborted message content (for history sent to LLM).
   * Only applies if preservePartialOnAbort is true.
   * @default ''
   */
  abortSuffix?: string
}

// Capabilities (from API)
export interface Capabilities {
  thinking: boolean
  streaming: boolean
  tools: string[]
}

// --- Step Chain Types ---

/**
 * A completed step in the response chain.
 * Steps accumulate as the model thinks, calls tools, and generates text.
 */
export type ResponseStep =
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      arguments: string
      result?: string
      error?: string
      state: 'pending' | 'complete' | 'error'
    }
  | { type: 'text'; content: string }

/**
 * The currently streaming step (actively receiving chunks).
 */
export interface ActiveStep {
  type: 'thinking' | 'text'
  content: string
}

// --- Messages ---

// Use universal Message interface from core lib
export type { Message } from '../../lib/chat/types'

// --- Server Stream Events ---

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type StreamEvent =
  | { type: 'session_info'; capabilities: Capabilities; persona: string | null }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; calls: { id: string; name: string; arguments: any }[] }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'tool_error'; id: string; name: string; message: string }
  | { type: 'complete'; text: string; usage?: TokenUsage }
  | { type: 'error'; message: string; recoverable: boolean }
  | IsomorphicHandoffStreamEvent
  | ConversationStateStreamEvent

/**
 * Event emitted to provide full conversation state for client-side processing.
 * Used when isomorphic tools need handoff to client.
 */
export interface ConversationStateStreamEvent {
  type: 'conversation_state'
  conversationState: ConversationState
}

/**
 * Event emitted when an isomorphic tool's server part completes.
 * 
 * The client should:
 * 1. Look up the tool in its isomorphic registry
 * 2. Execute the client part with the serverOutput
 * 3. For client-authority tools: send result back to server
 * 4. Results are merged and continue the conversation
 */
export interface IsomorphicHandoffStreamEvent {
  type: 'isomorphic_handoff'
  /** Unique ID of this tool call */
  callId: string
  /** Name of the isomorphic tool */
  toolName: string
  /** Original params from LLM */
  params: unknown
  /** Output from server execution (undefined for client-authority) */
  serverOutput: unknown
  /** Authority mode determines data flow */
  authority: 'server' | 'client'
  /** True if this handoff uses the V7 two-phase pattern */
  usesHandoff?: boolean
}


/**
 * Snapshot of conversation state when handing off to client for tool execution.
 */
export interface ConversationState {
  /** Full message history up to this point */
  messages: ApiMessage[]
  /** Text content the assistant generated before requesting tools */
  assistantContent: string
  /** Tool calls the assistant requested (both server and client) */
  toolCalls: ToolCallInfo[]
  /** Results from server-side tool execution (already complete) */
  serverToolResults: ServerToolResult[]
}

export interface ServerToolResult {
  id: string
  name: string
  content: string
  isError: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

// --- Commands (React -> Session) ---

export type ChatCommand =
  | { type: 'send'; content: string }
  | { 
      type: 'abort'
      /** Raw text from UI buffer (settled + pending) */
      partialContent?: string
      /** Rendered HTML (settled only, for display) */
      partialHtml?: string
    }
  | { type: 'reset' }

// --- Patches (Session -> React) ---

/**
 * Dual buffer patch - emitted by dualBufferTransform.
 * 
 * The dual buffer pattern (like double buffering in games) provides:
 * - `settled`: Content that's safe to parse/render (paragraph complete, etc.)
 * - `pending`: Content still streaming in (render as raw text with cursor)
 * 
 * The `prev`/`next` pattern allows consumers to detect changes and
 * animate transitions if desired.
 * 
 * ## Processor Enrichments
 * 
 * When a processor is configured, additional fields are added:
 * - `html`: Parsed HTML (from markdown processor)
 * - `ast`: Parsed AST (for syntax highlighting)
 * - `pass`: Progressive enhancement pass ('quick' | 'full')
 * - `meta`: Settler metadata (e.g., code fence info)
 * - etc.
 * 
 * These fields come from the processor's `ProcessedOutput`.
 */
export type BufferSettledPatch = {
  type: 'buffer_settled'
  content: string   // The chunk that just settled
  prev: string      // Previous settled total
  next: string      // New settled total (prev + content)
  // Processor enrichments (optional, extensible)
  html?: string     // Parsed HTML, if markdown processor ran
  ast?: unknown     // Parsed AST, for advanced processing
  pass?: 'quick' | 'full'  // Progressive enhancement pass
  meta?: SettleMeta // Settler metadata (e.g., code fence info)
  [key: string]: unknown  // Allow additional processor fields
}

export type BufferPendingPatch = {
  type: 'buffer_pending'
  content: string   // Current pending buffer (full replacement)
}

export type BufferRawPatch = {
  type: 'buffer_raw'
  content: string   // Current raw buffer (full replacement)
}

export type BufferRenderablePatch = {
  type: 'buffer_renderable'
  prev: string      // Previous renderable content
  next: string      // New renderable content
  html?: string     // Processed HTML, if enhancer ran
  meta?: SettleMeta // Metadata from chunkers/enhancers
  [key: string]: unknown  // Allow additional fields
}

// --- Client Tool Patches ---

/**
 * Emitted when a client tool is waiting for user approval.
 */
export type ClientToolAwaitingApprovalPatch = {
  type: 'client_tool_awaiting_approval'
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Message to display in approval dialog */
  message: string
}

/**
 * Emitted when a client tool starts executing (after approval).
 */
export type ClientToolExecutingPatch = {
  type: 'client_tool_executing'
  /** Tool call ID */
  id: string
}

/**
 * Emitted when a client tool completes successfully.
 */
export type ClientToolCompletePatch = {
  type: 'client_tool_complete'
  /** Tool call ID */
  id: string
  /** Tool result (serialized to string) */
  result: string
}

/**
 * Emitted when a client tool encounters an error.
 */
export type ClientToolErrorPatch = {
  type: 'client_tool_error'
  /** Tool call ID */
  id: string
  /** Error message */
  error: string
}

/**
 * Emitted when a client tool is denied by the user.
 */
export type ClientToolDeniedPatch = {
  type: 'client_tool_denied'
  /** Tool call ID */
  id: string
  /** Reason for denial */
  reason: string
}

/**
 * Emitted when a client tool reports progress.
 */
export type ClientToolProgressPatch = {
  type: 'client_tool_progress'
  /** Tool call ID */
  id: string
  /** Progress message */
  message: string
}

/**
 * Emitted when a client tool needs browser permission.
 */
export type ClientToolPermissionRequestPatch = {
  type: 'client_tool_permission_request'
  /** Tool call ID */
  id: string
  /** Type of permission needed */
  permissionType: string
}

// --- Isomorphic Tool Patches ---

/**
 * Authority mode for isomorphic tools.
 */
export type AuthorityMode = 'server' | 'client'

/**
 * State of an isomorphic tool during execution.
 */
export type IsomorphicToolState =
  | 'pending'
  | 'server_executing'
  | 'awaiting_client_approval'
  | 'client_executing'
  | 'server_validating'
  | 'complete'
  | 'error'
  | 'denied'

/**
 * Emitted when an isomorphic tool's state changes.
 */
export type IsomorphicToolStatePatch = {
  type: 'isomorphic_tool_state'
  /** Tool call ID */
  id: string
  /** Current state */
  state: IsomorphicToolState
  /** Authority mode */
  authority: AuthorityMode
  /** Server output (if available) */
  serverOutput?: unknown
  /** Client output (if available) */
  clientOutput?: unknown
  /** Error message (if failed) */
  error?: string
}

// --- Tool Handoff Patches (for React Tool Handlers) ---

/**
 * A pending handoff waiting for React UI to respond.
 *
 * This matches the PendingHandoff interface from tool-handlers.ts
 * but is defined here to avoid circular dependencies.
 */
export interface PendingHandoffState {
  /** Unique identifier for this tool call */
  callId: string
  /** The tool name */
  toolName: string
  /** The params passed to the tool */
  params: unknown
  /** The handoff data (from before() or server output) */
  data: unknown
  /** The authority mode of the tool */
  authority: 'server' | 'client'
  /** Whether this tool uses the V7 handoff pattern */
  usesHandoff: boolean
}

/**
 * Emitted when a tool is waiting for React UI to handle it.
 */
export type PendingHandoffPatch = {
  type: 'pending_handoff'
  /** The handoff to add to pending state */
  handoff: PendingHandoffState
}

/**
 * Emitted when a React handler responds to a handoff.
 */
export type HandoffCompletePatch = {
  type: 'handoff_complete'
  /** The tool call ID */
  callId: string
}

// --- Execution Trail Patches (for ctx.render pattern) ---

/**
 * Emitted when a step-enabled tool starts execution.
 */
export type ExecutionTrailStartPatch = {
  type: 'execution_trail_start'
  /** The tool call ID */
  callId: string
  /** The tool name */
  toolName: string
}

/**
 * Emitted when a step is produced by a tool.
 * 
 * The step may be:
 * - An emit step (fire-and-forget, no response needed)
 * - A prompt step (waiting for user response)
 * - A render step (React element waiting for response)
 */
export type ExecutionTrailStepPatch = {
  type: 'execution_trail_step'
  /** The tool call ID */
  callId: string
  /** The step data */
  step: {
    id: string
    kind: 'emit' | 'prompt'
    type?: string
    payload?: unknown
    /** React element for render steps (serialized or reference) */
    element?: unknown
    /** React component for factory pattern (ctx.step) */
    component?: unknown
    timestamp: number
    status: 'pending' | 'complete'
    response?: unknown
  }
  /** Respond function (only for prompts) - React should call this */
  respond?: (response: unknown) => void
}

/**
 * Emitted when a step-enabled tool completes execution.
 */
export type ExecutionTrailCompletePatch = {
  type: 'execution_trail_complete'
  /** The tool call ID */
  callId: string
  /** The final result */
  result?: unknown
  /** Error if failed */
  error?: string
}

/**
 * Emitted when a step receives a response.
 * 
 * This updates the step status in executionTrails and removes it from pendingSteps.
 * Used to keep step state in sync when user responds to interactive steps.
 */
export type ExecutionTrailStepResponsePatch = {
  type: 'execution_trail_step_response'
  /** The step ID that received a response */
  stepId: string
  /** The tool call ID this step belongs to */
  callId: string
  /** The response value */
  response: unknown
}

export type ChatPatch =
  | { type: 'session_info'; capabilities: Capabilities; persona: string | null }
  | { type: 'user_message'; message: Message; rendered?: string }
  | { type: 'assistant_message'; message: Message; rendered?: string }
  | { type: 'streaming_start' }
  | { type: 'streaming_text'; content: string }
  | { type: 'streaming_thinking'; content: string }
  | { type: 'streaming_end' }
  | { type: 'tool_call_start'; call: { id: string; name: string; arguments: string } }
  | { type: 'tool_call_result'; id: string; result: string }
  | { type: 'tool_call_error'; id: string; error: string }
  | { type: 'abort_complete'; message?: Message; rendered?: string }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  // Buffer patches
  | BufferSettledPatch
  | BufferPendingPatch
  | BufferRawPatch
  | BufferRenderablePatch
  // Client tool patches
  | ClientToolAwaitingApprovalPatch
  | ClientToolExecutingPatch
  | ClientToolCompletePatch
  | ClientToolErrorPatch
  | ClientToolDeniedPatch
  | ClientToolProgressPatch
  | ClientToolPermissionRequestPatch
  // Isomorphic tool patches
  | IsomorphicToolStatePatch
  // Tool handoff patches (for React tool handlers)
  | PendingHandoffPatch
  | HandoffCompletePatch
  // Execution trail patches (for ctx.render pattern)
  | ExecutionTrailStartPatch
  | ExecutionTrailStepPatch
  | ExecutionTrailCompletePatch
  | ExecutionTrailStepResponsePatch

// --- Rendered Content ---

/**
 * Rendered output for a message.
 * 
 * This is the result of running a message through the rendering pipeline.
 * Keyed by message ID in ChatState.rendered.
 */
export interface RenderedContent {
  /** Output from the renderer (could be HTML, plain text, etc.) */
  output?: string
  // Future: codeBlocks?, images?, etc.
}

// --- Unified Timeline Types ---

/**
 * A unified timeline contains all items in render order.
 * 
 * This is the primary data structure for rendering chat UI. Everything
 * appears in one flat array: user messages, assistant text, tool calls,
 * and interactive steps.
 * 
 * Steps have a `callId` to reference their parent tool call. Users can
 * group by callId if they want nested rendering, or render flat inline.
 * 
 * ## Design Principles
 * 
 * 1. **Flat by default** - Simple .map() for inline rendering
 * 2. **Groupable** - Use groupByToolCall() helper for nesting
 * 3. **Serializable** - All data (except transient `element`) is serializable
 * 4. **Headless** - No rendering opinions, just data + callbacks
 */
export type TimelineItem =
  | TimelineUserMessage
  | TimelineAssistantText
  | TimelineThinking
  | TimelineToolCall
  | TimelineStep

/**
 * User message in the timeline.
 */
export interface TimelineUserMessage {
  type: 'user'
  id: string
  content: string
  timestamp: number
}

/**
 * Assistant text in the timeline.
 */
export interface TimelineAssistantText {
  type: 'assistant_text'
  id: string
  content: string
  timestamp: number
}

/**
 * Thinking block in the timeline (model reasoning).
 */
export interface TimelineThinking {
  type: 'thinking'
  id: string
  content: string
  timestamp: number
}

/**
 * Tool call in the timeline.
 * 
 * Steps are separate items with matching `callId`, not nested here.
 * This keeps the timeline flat for easy inline rendering.
 */
export interface TimelineToolCall {
  type: 'tool_call'
  id: string
  callId: string
  toolName: string
  input: unknown
  state: 'running' | 'complete' | 'error'
  output?: unknown
  error?: string
  timestamp: number
}

/**
 * Interactive step in the timeline.
 * 
 * Steps are produced by tools using ctx.step() or ctx.render().
 * They appear inline in the timeline and can be pending (awaiting user input)
 * or complete.
 * 
 * For pending steps, the UI should render based on:
 * - `element` if present (from ctx.render()) - a React element to clone with onRespond
 * - `stepType` + `payload` (from ctx.step()) - data to render with a component map
 * 
 * The `element` field is transient and not serialized. For replay/persistence,
 * use `stepType` + `payload` + a component registry.
 */
export interface TimelineStep {
  type: 'step'
  id: string
  /** Parent tool call ID */
  callId: string
  /** 
   * Step type for component lookup.
   * Use this + payload for serializable rendering.
   */
  stepType: string
  /** Serializable payload data */
  payload: unknown
  /** Current state */
  state: 'pending' | 'complete'
  /** Response once user completes the step */
  response?: unknown
  /** 
   * React element for ctx.render() - TRANSIENT.
   * 
   * Present only for live steps from ctx.render().
   * Not serialized. For replay, use stepType + payload + component map.
   */
  element?: unknown
  /** Respond function for pending steps */
  respond?: (response: unknown) => void
  timestamp: number
}



// --- Session State (React-side) ---

/**
 * State of a pending client tool (for UI rendering).
 */
export interface PendingClientToolState {
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Current state */
  state: 'awaiting_approval' | 'executing' | 'complete' | 'error' | 'denied'
  /** Approval message to display */
  approvalMessage?: string
  /** Progress message during execution */
  progressMessage?: string
  /** Result if complete */
  result?: string
  /** Error message if failed */
  error?: string
  /** Denial reason */
  denialReason?: string
  /** Permission type if this is a permission request */
  permissionType?: string
}

export interface ChatState {
  messages: Message[]

  /**
   * Unified timeline - everything in render order.
   * 
   * This is the primary data structure for rendering chat UI.
   * Contains user messages, assistant text, tool calls, and interactive steps
   * all in one flat array.
   * 
   * For nested rendering (tool calls with their steps grouped), use
   * `groupTimelineByToolCall(timeline)`.
   * 
   * @example
   * ```tsx
   * {timeline.map(item => {
   *   if (item.type === 'user') return <UserMessage {...item} />
   *   if (item.type === 'step' && item.state === 'pending') {
   *     return <StepRenderer step={item} onRespond={...} />
   *   }
   * })}
   * ```
   */
  timeline: TimelineItem[]

  /**
   * Rendered content for each message, keyed by message ID.
   * 
   * Both user and assistant messages can have rendered content.
   * This is populated when messages are finalized (not during streaming).
   */
  rendered: Record<string, RenderedContent>

  /** Completed steps in the current response being built */
  currentResponse: ResponseStep[]

  /** Currently streaming step (actively receiving chunks) */
  activeStep: ActiveStep | null

  isStreaming: boolean
  error: string | null
  capabilities: Capabilities | null
  persona: string | null

  /**
   * Dual buffer state (when using dualBufferTransform)
   * - settled: Content that's safe to parse/render as markdown
   * - pending: Content still streaming in (render as raw text)
   * - settledHtml: Parsed HTML (when using markdownTransform)
   */
  buffer: {
    settled: string
    pending: string
    settledHtml: string
  }

  /**
   * Pending client tools awaiting approval or executing.
   * 
   * Keyed by tool call ID for easy lookup and update.
   * Used by UI to render approval dialogs and progress.
   */
  pendingClientTools: Record<string, PendingClientToolState>

  /**
   * Pending tool handoffs waiting for React UI handlers.
   *
   * These are tools that want to render React UI instead of running
   * a `*client()` generator. The React component uses `createToolHandlers()`
   * to render UI and calls `respondToHandoff()` when done.
   *
   * Keyed by callId for easy lookup and removal.
   */
  pendingHandoffs: Record<string, PendingHandoffState>

  /**
   * Pending steps from tools using ctx.render() pattern.
   *
   * These are steps (prompts) that need user input before the tool can continue.
   * The React component renders the step's element and calls respondToStep()
   * when the user provides input.
   *
   * Keyed by step ID for easy lookup and removal.
   */
  pendingSteps: Record<string, PendingStepState>

  /**
   * Active execution trails for tools using ctx.render() pattern.
   *
   * Keyed by callId. Includes all steps (both emit and prompt) for replay/display.
   */
  executionTrails: Record<string, ExecutionTrailState>
}

/**
 * State of a pending step waiting for user response.
 */
export interface PendingStepState {
  /** The step ID */
  stepId: string
  /** The tool call ID this step belongs to */
  callId: string
  /** Step kind (should be 'prompt' for pending steps) */
  kind: 'emit' | 'prompt'
  /** Step type for routing (or '__react__' for render steps) */
  type?: string
  /** Payload for type-based steps */
  payload?: unknown
  /** React element for render steps */
  element?: unknown
  /** React component for factory pattern (ctx.step) */
  component?: unknown
  /** Timestamp */
  timestamp: number
  /** Respond function - call this to complete the step */
  respond: (response: unknown) => void
}

/**
 * State of an execution trail for a tool call.
 */
export interface ExecutionTrailState {
  /** The tool call ID */
  callId: string
  /** The tool name */
  toolName: string
  /** All steps in order */
  steps: Array<{
    id: string
    kind: 'emit' | 'prompt'
    type?: string
    payload?: unknown
    element?: unknown
    timestamp: number
    status: 'pending' | 'complete'
    response?: unknown
  }>
  /** Trail status */
  status: 'running' | 'complete' | 'error'
  /** Start timestamp */
  startedAt: number
  /** End timestamp */
  completedAt?: number
  /** Result if complete */
  result?: unknown
  /** Error if failed */
  error?: string
}

export const initialChatState: ChatState = {
  messages: [],
  timeline: [],
  rendered: {},
  currentResponse: [],
  activeStep: null,
  isStreaming: false,
  error: null,
  capabilities: null,
  persona: null,
  buffer: {
    settled: '',
    pending: '',
    settledHtml: '',
  },
  pendingClientTools: {},
  pendingHandoffs: {},
  pendingSteps: {},
  executionTrails: {},
}
