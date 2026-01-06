/**
 * Isomorphic Tools - One definition, server AND client execution.
 *
 * KEY PRINCIPLE: Server's return value is ALWAYS the final result to the LLM.
 * There is no "merge" function.
 *
 * ## API: Type-Safe Builder
 *
 * ```typescript
 * import { createIsomorphicTool } from '@/lib/chat/isomorphic-tools'
 *
 * const guessCard = createIsomorphicTool('guess_card')
 *   .description('Pick and guess a card')
 *   .parameters(z.object({ prompt: z.string() }))
 *   .context('browser')  // declares what context APIs the tool needs
 *   .authority('server')
 *   .handoff({
 *     *before(params) { return { secret: pickCard() } },
 *     *client(handoff) { return { guess: yield* showUI(handoff) } },
 *     *after(handoff, client) { return { correct: client.guess === handoff.secret } },
 *   })
 * ```
 *
 * ## Type-Safe Client Handlers
 *
 * ```typescript
 * import { createHandoffHandler, createHandoffRegistry } from '@/lib/chat/isomorphic-tools'
 *
 * // Create typed handler - handoff data is fully typed!
 * const handleGuessCard = createHandoffHandler(guessCard, (handoff, params, respond) => {
 *   // handoff.secret, handoff.choices are typed
 *   return <CardPicker choices={handoff.choices} onPick={card => respond({ guess: card })} />
 * })
 *
 * // Use in component
 * const registry = createHandoffRegistry([handleGuessCard])
 * const ui = registry.handle(event, onRespond)
 * ```
 *
 * @packageDocumentation
 */

// --- Builder Pattern (RECOMMENDED) ---
export {
  createIsomorphicTool,
  type FinalizedIsomorphicTool,
  type TypedHandoffConfig,
  type IsomorphicToolTypes,
  type InferToolResult,
  type InferToolParams,
  type InferToolHandoff,
  type InferToolClientOutput,
} from './builder'

// --- Type-Safe Client Hooks ---
export {
  createHandoffHandler,
  createHandoffRegistry,
  createTypedPendingHandoff,
  narrowHandoff,
  type HandoffHandler,
  type TypedHandoffHandler,
  type HandoffHandlerRegistry,
  type TypedPendingHandoff,
  type ExtractHandoff,
  type ExtractClientOutput,
  type ExtractParams,
  type ToolHandoffUnion,
} from './client-hooks'

// --- Tool Handlers (React Integration) ---
export {
  createToolHandlers,
  createHandlerRegistry,
  handler,
  isHandoffFor,
  type PendingHandoff,
  type HandoffData,
  type TypedHandler,
  type ToolHandlerRegistry,
  type ToolHandlerBuilder,
} from './tool-handlers'

// --- Registry ---
export {
  createIsomorphicToolRegistry,
} from './registry'

// --- Executor ---
export {
  executeServerPart,
  executeServerPhase2,
  executeClientPart,
  executeIsomorphicToolsClient,
  executeIsomorphicToolsClientWithReactHandlers,
  formatIsomorphicToolResult,
  type ReactHandlerExecutionOptions,
} from './executor'

// --- Demo Tools ---
export { cardGameIsomorphicTools } from './card-game'

// --- Types ---
export type {
  // Core definitions
  IsomorphicToolDef,
  AnyIsomorphicTool,

  // Authority
  AuthorityMode,

  // Context
  ServerToolContext,
  ServerAuthorityContext,

  // Context types (declarative context for tools)
  ContextMode,
  BaseToolContext,
  BrowserToolContext,
  AgentToolContext,
  PromptOptions,
  ContextForMode,
  AnyToolContext,

  // Registry
  IsomorphicToolRegistry,
  IsomorphicToolSchema,

  // Events
  IsomorphicHandoffEvent,

  // Results
  IsomorphicToolResult,

  // State
  IsomorphicToolState,
} from './types'

// --- Errors ---
export { HandoffReadyError } from './types'

// --- UI Requests (waitFor pattern) ---
export {
  createWaitForContext,
  createUIRequestChannel,
  createUIHandlers,
  type UIRequest,
  type PendingUIRequest,
  type WaitForContext,
  type UIHandler,
  type UIHandlerRegistry,
  type UIHandlerBuilder,
  type UIResponseValue,
} from './ui-requests'

// --- Emission Runtime (ctx.render pattern - new) ---
export {
  type RenderableProps,
  type ExtractResponse,
  type UserProps,
  type BrowserRenderContext,
} from './runtime/browser-context'

// --- Agent Runtime (server-side agent execution) ---
export {
  runAsAgent,
  createAgentLLMClient,
  createMockAgentToolContext,
  createMockAgentToolContextWithResponder,
  type AgentLLMClient,
  type CreateAgentLLMClientOptions,
  type RunAsAgentOptions,
  type CreateMockAgentToolContextOptions,
} from './agent-runtime'
