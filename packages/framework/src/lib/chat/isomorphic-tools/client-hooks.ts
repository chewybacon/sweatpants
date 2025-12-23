/**
 * Type-Safe Client Hooks for Isomorphic Tools
 *
 * These hooks provide type-safe access to handoff data from the builder pattern.
 * They extract the `THandoff` type from `before()` and apply it to the client-side.
 *
 * ## The Problem
 *
 * When the server hands off to the client, the data is serialized and sent as JSON.
 * The client receives `serverOutput: unknown`, losing all type information.
 *
 * ## The Solution
 *
 * Use the builder's phantom types to create typed handlers:
 *
 * ```typescript
 * // 1. Define tool with builder (types are preserved)
 * const guessCard = createIsomorphicTool('guess_card')
 *   .description('Guess a card')
 *   .parameters(z.object({ prompt: z.string() }))
 *   .authority('server')
 *   .handoff({
 *     *before(params) {
 *       return { secret: 'Ace', choices: ['Ace', 'King', 'Queen'] }
 *     },
 *     *client(handoff, ctx) {
 *       return { guess: handoff.choices[0] }
 *     },
 *     *after(handoff, client) {
 *       return { correct: client.guess === handoff.secret }
 *     },
 *   })
 *
 * // 2. Create typed handler from tool
 * const handleGuessCard = createHandoffHandler(guessCard, (handoff, respond) => {
 *   // handoff is typed as { secret: string, choices: string[] }
 *   return (
 *     <CardPicker
 *       choices={handoff.choices}
 *       onPick={(card) => respond({ guess: card })}
 *     />
 *   )
 * })
 *
 * // 3. Use in React component
 * function ToolHandler({ event }: { event: IsomorphicHandoffEvent }) {
 *   if (event.toolName === 'guess_card') {
 *     return handleGuessCard(event)
 *   }
 *   // ...
 * }
 * ```
 */
import type { ReactNode } from 'react'
import type { FinalizedIsomorphicTool } from './builder'
import type { IsomorphicHandoffEvent } from './types'

// =============================================================================
// TYPE EXTRACTION
// =============================================================================

/**
 * Extract the handoff type (before() return) from a finalized tool.
 */
export type ExtractHandoff<T> = T extends FinalizedIsomorphicTool<
  any, any, any, infer THandoff, any, any
> ? THandoff : unknown

/**
 * Extract the client output type from a finalized tool.
 */
export type ExtractClientOutput<T> = T extends FinalizedIsomorphicTool<
  any, any, any, any, infer TClient, any
> ? TClient : unknown

/**
 * Extract the params type from a finalized tool.
 */
export type ExtractParams<T> = T extends FinalizedIsomorphicTool<
  any, infer TParams, any, any, any, any
> ? TParams : unknown

// =============================================================================
// HANDOFF HANDLER
// =============================================================================

/**
 * A typed handler for a specific tool's handoff.
 *
 * The handler receives:
 * - `handoff`: The typed data from `before()` (narrowed from `serverOutput`)
 * - `params`: The typed params from the tool call
 * - `respond`: A callback to send the client response (typed to match `client()` return)
 *
 * Returns a React node to render the tool UI.
 */
export type HandoffHandler<THandoff, TParams, TClient> = (
  handoff: THandoff,
  params: TParams,
  respond: (clientOutput: TClient) => void,
  event: IsomorphicHandoffEvent
) => ReactNode

/**
 * A tool-specific handoff handler that can be used directly with an event.
 */
export interface TypedHandoffHandler<THandoff, _TParams, TClient> {
  /**
   * Handle a handoff event for this tool.
   * Returns null if the event is not for this tool.
   */
  (event: IsomorphicHandoffEvent, respond: (clientOutput: TClient) => void): ReactNode | null
  
  /**
   * The tool name this handler is for.
   */
  toolName: string
  
  /**
   * Type marker for the handoff data type.
   */
  _handoffType: THandoff
  
  /**
   * Type marker for the client output type.
   */
  _clientType: TClient
}

/**
 * Create a typed handoff handler for a specific tool.
 *
 * This extracts the types from the builder and applies them to the handler function,
 * giving you full IntelliSense for the handoff data.
 *
 * @example
 * ```typescript
 * const handleGuessCard = createHandoffHandler(guessCardTool, (handoff, params, respond) => {
 *   // handoff is typed as { secret: string, choices: string[] }
 *   // params is typed as { prompt: string }
 *   // respond expects { guess: string }
 *   return (
 *     <CardPicker
 *       choices={handoff.choices}
 *       hint={params.prompt}
 *       onPick={(card) => respond({ guess: card })}
 *     />
 *   )
 * })
 * ```
 */
export function createHandoffHandler<
  TTool extends FinalizedIsomorphicTool<any, any, any, any, any, any>,
  THandoff = ExtractHandoff<TTool>,
  TParams = ExtractParams<TTool>,
  TClient = ExtractClientOutput<TTool>,
>(
  tool: TTool,
  handler: HandoffHandler<THandoff, TParams, TClient>
): TypedHandoffHandler<THandoff, TParams, TClient> {
  const typedHandler = (
    event: IsomorphicHandoffEvent,
    respond: (clientOutput: TClient) => void
  ): ReactNode | null => {
    if (event.toolName !== tool.name) {
      return null
    }
    
    // Cast the unknown data to our typed versions
    // This is safe because the tool name matches
    const handoff = event.serverOutput as THandoff
    const params = event.params as TParams
    
    return handler(handoff, params, respond, event)
  }
  
  typedHandler.toolName = tool.name
  typedHandler._handoffType = undefined as unknown as THandoff
  typedHandler._clientType = undefined as unknown as TClient
  
  return typedHandler
}

// =============================================================================
// HANDLER REGISTRY
// =============================================================================

/**
 * A registry of typed handoff handlers.
 *
 * This lets you define handlers for multiple tools and dispatch based on tool name.
 */
export interface HandoffHandlerRegistry {
  /**
   * Handle a handoff event by dispatching to the appropriate handler.
   * Returns null if no handler is registered for the tool.
   */
  handle(event: IsomorphicHandoffEvent, respond: (output: unknown) => void): ReactNode | null
  
  /**
   * Get the handler for a specific tool name.
   */
  get(toolName: string): TypedHandoffHandler<any, any, any> | undefined
  
  /**
   * Check if a handler exists for a tool.
   */
  has(toolName: string): boolean
}

/**
 * Create a registry of typed handoff handlers.
 *
 * @example
 * ```typescript
 * const handlers = createHandoffRegistry([
 *   createHandoffHandler(guessCardTool, (handoff, params, respond) => ...),
 *   createHandoffHandler(pickNumberTool, (handoff, params, respond) => ...),
 * ])
 *
 * // In React component
 * function ToolRenderer({ event, onRespond }) {
 *   const ui = handlers.handle(event, onRespond)
 *   if (ui) return ui
 *   return <div>Unknown tool: {event.toolName}</div>
 * }
 * ```
 */
export function createHandoffRegistry(
  handlers: TypedHandoffHandler<any, any, any>[]
): HandoffHandlerRegistry {
  const map = new Map<string, TypedHandoffHandler<any, any, any>>()
  
  for (const handler of handlers) {
    if (map.has(handler.toolName)) {
      throw new Error(`Duplicate handoff handler for tool: ${handler.toolName}`)
    }
    map.set(handler.toolName, handler)
  }
  
  return {
    handle(event, respond) {
      const handler = map.get(event.toolName)
      if (!handler) return null
      return handler(event, respond)
    },
    
    get(toolName) {
      return map.get(toolName)
    },
    
    has(toolName) {
      return map.has(toolName)
    },
  }
}

// =============================================================================
// REACT HOOK FOR PENDING HANDOFFS
// =============================================================================

/**
 * Type for a pending handoff with typed data.
 *
 * This is what gets exposed to React when there's a pending handoff.
 */
export interface TypedPendingHandoff<THandoff, TParams, TClient> {
  /** The handoff event */
  event: IsomorphicHandoffEvent
  
  /** Typed handoff data from before() */
  handoff: THandoff
  
  /** Typed params from tool call */
  params: TParams
  
  /** Callback to respond with typed client output */
  respond: (output: TClient) => void
  
  /** Tool name */
  toolName: string
  
  /** Call ID */
  callId: string
}

/**
 * Create a typed pending handoff object from an event.
 *
 * This is a helper to bridge between the untyped event system and typed React handlers.
 *
 * @example
 * ```typescript
 * // In a hook or component
 * const pendingHandoff = createTypedPendingHandoff(
 *   guessCardTool,
 *   event,
 *   (output) => sendClientOutput(event.callId, output)
 * )
 *
 * if (pendingHandoff) {
 *   // pendingHandoff.handoff is typed as { secret: string, choices: string[] }
 *   // pendingHandoff.respond expects { guess: string }
 * }
 * ```
 */
export function createTypedPendingHandoff<
  TTool extends FinalizedIsomorphicTool<any, any, any, any, any, any>,
  THandoff = ExtractHandoff<TTool>,
  TParams = ExtractParams<TTool>,
  TClient = ExtractClientOutput<TTool>,
>(
  tool: TTool,
  event: IsomorphicHandoffEvent,
  respond: (output: TClient) => void
): TypedPendingHandoff<THandoff, TParams, TClient> | null {
  if (event.toolName !== tool.name) {
    return null
  }
  
  return {
    event,
    handoff: event.serverOutput as THandoff,
    params: event.params as TParams,
    respond,
    toolName: tool.name,
    callId: event.callId,
  }
}

// =============================================================================
// DISCRIMINATED UNION HELPER
// =============================================================================

/**
 * Create a discriminated union type from multiple tools.
 *
 * This is useful when you have a switch statement handling different tools.
 *
 * @example
 * ```typescript
 * type MyToolHandoffs = ToolHandoffUnion<[
 *   typeof guessCardTool,
 *   typeof pickNumberTool,
 * ]>
 *
 * // MyToolHandoffs is:
 * // | { tool: 'guess_card', handoff: { secret: string, ... }, ... }
 * // | { tool: 'pick_number', handoff: { number: number, ... }, ... }
 *
 * function handleTool(data: MyToolHandoffs) {
 *   switch (data.tool) {
 *     case 'guess_card':
 *       // data.handoff is { secret: string, choices: string[] }
 *       break
 *     case 'pick_number':
 *       // data.handoff is { number: number, hint: string }
 *       break
 *   }
 * }
 * ```
 */
export type ToolHandoffUnion<TTools extends readonly FinalizedIsomorphicTool<any, any, any, any, any, any>[]> = {
  [K in keyof TTools]: TTools[K] extends FinalizedIsomorphicTool<
    infer TName,
    infer TParams,
    any,
    infer THandoff,
    infer TClient,
    any
  >
    ? {
        tool: TName
        handoff: THandoff
        params: TParams
        respond: (output: TClient) => void
        callId: string
      }
    : never
}[number]

/**
 * Narrow a handoff event to a specific tool's types.
 *
 * Returns null if the event doesn't match the tool.
 */
export function narrowHandoff<
  TTool extends FinalizedIsomorphicTool<any, any, any, any, any, any>,
>(
  tool: TTool,
  event: IsomorphicHandoffEvent,
  respond: (output: ExtractClientOutput<TTool>) => void
): {
  handoff: ExtractHandoff<TTool>
  params: ExtractParams<TTool>
  respond: (output: ExtractClientOutput<TTool>) => void
} | null {
  if (event.toolName !== tool.name) {
    return null
  }
  
  return {
    handoff: event.serverOutput as ExtractHandoff<TTool>,
    params: event.params as ExtractParams<TTool>,
    respond,
  }
}
