/**
 * Tool Handlers API for React Integration
 *
 * This module provides a type-safe way to handle pending tool handoffs
 * in React components. It's designed to work with useChatSession's
 * pendingHandoffs and respondToHandoff.
 *
 * ## Usage
 *
 * ```tsx
 * import { createToolHandlers } from '@/lib/chat/isomorphic-tools/tool-handlers'
 *
 * // 1. Create handler registry with full type inference
 * const toolHandlers = createToolHandlers()
 *   .add(guessTheCardTool, (data, respond) => {
 *     // data is typed: { secret, choices, hint, prompt, secretColor }
 *     // respond expects: { guess: string }
 *     return (
 *       <CardPicker
 *         choices={data.choices}
 *         hint={data.hint}
 *         onPick={(card) => respond({ guess: card })}
 *       />
 *     )
 *   })
 *   .add(askYesNoTool, (data, respond) => {
 *     // data is typed: { question, context? }
 *     // respond expects: { answer: boolean, question: string }
 *     return (
 *       <YesNoDialog
 *         question={data.question}
 *         onYes={() => respond({ answer: true, question: data.question })}
 *         onNo={() => respond({ answer: false, question: data.question })}
 *       />
 *     )
 *   })
 *   .build()
 *
 * // 2. Use with useChatSession
 * function ChatComponent() {
 *   const { pendingHandoffs, respondToHandoff } = useChatSession({
 *     tools: [guessTheCardTool, askYesNoTool],
 *   })
 *
 *   return (
 *     <div>
 *       {toolHandlers.render(pendingHandoffs, respondToHandoff)}
 *     </div>
 *   )
 * }
 *
 * // 3. Or render manually with type narrowing
 * function ManualRender({ handoff }: { handoff: PendingHandoff }) {
 *   if (isHandoffFor(handoff, guessTheCardTool)) {
 *     return <CardPicker choices={handoff.data.choices} ... />
 *   }
 *   if (isHandoffFor(handoff, askYesNoTool)) {
 *     return <YesNoDialog question={handoff.data.question} ... />
 *   }
 *   return null
 * }
 * ```
 *
 * @packageDocumentation
 */
import type { ReactNode } from 'react'
import type { FinalizedIsomorphicTool } from './builder.ts'
import type { z } from 'zod'
import type {
  ServerAuthorityToolDef,
  ClientAuthorityToolDef,
  AnyIsomorphicTool,
} from './types.ts'

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Base tool type that encompasses both raw definitions and finalized tools.
 * This allows the handler API to accept tools from either defineIsomorphicTool()
 * or createIsomorphicTool().build()
 */
export type AnyToolDef = AnyIsomorphicTool | FinalizedIsomorphicTool<any, any, any, any, any, any, any>

/**
 * Extract the client output type from any tool definition.
 * 
 * For FinalizedIsomorphicTool: uses the builder's type inference
 * For raw definitions: infers from the client generator's return type
 */
type ExtractClientOutput<T> = 
  // FinalizedIsomorphicTool path
  T extends FinalizedIsomorphicTool<any, any, any, any, any, infer TClient, any>
    ? TClient
  // ClientAuthorityToolDef path
  : T extends ClientAuthorityToolDef<any, any, infer TClient>
    ? TClient
  // ServerAuthorityToolDef path  
  : T extends ServerAuthorityToolDef<any, any, infer TClient>
    ? TClient
  : unknown

/**
 * What data does a tool provide to its handler?
 *
 * - Client-authority tools: receive params
 * - Server-authority with handoff: receive handoff data from before()
 * - Server-authority without handoff: receive server output
 * 
 * Works with both FinalizedIsomorphicTool and raw definitions.
 */
export type HandoffData<T> = 
  // FinalizedIsomorphicTool path (builder-created)
  T extends FinalizedIsomorphicTool<
    any,
    infer TParams,
    any,  // TContext
    infer TAuthority,
    infer THandoff,
    any,  // TClient
    infer TResult
  >
    ? TAuthority extends 'client'
      ? TParams // Client-authority: receives params
      : THandoff extends undefined
        ? TResult // Server-authority without handoff: receives serverOutput
        : THandoff // Server-authority with handoff: receives handoff data
  // ClientAuthorityToolDef path (raw definition)
  : T extends ClientAuthorityToolDef<infer TParams, any, any>
    ? z.infer<TParams> // Client-authority: receives params
  // ServerAuthorityToolDef path (raw definition)
  : T extends ServerAuthorityToolDef<any, infer TServerOutput, any>
    ? TServerOutput // Server-authority: receives server output (or handoff data)
  : never

// =============================================================================
// PENDING HANDOFF
// =============================================================================

/**
 * A pending handoff from the session that needs UI handling.
 *
 * This is what useChatSession will expose when there's a tool
 * waiting for client input.
 */
export interface PendingHandoff {
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

// =============================================================================
// TYPED HANDLER
// =============================================================================

/**
 * A typed handler for a single tool.
 */
export interface TypedHandler<TTool> {
  tool: TTool
  handler: (
    data: HandoffData<TTool>,
    respond: (output: ExtractClientOutput<TTool>) => void
  ) => ReactNode
}

/**
 * Create a typed handler for a tool.
 *
 * This function provides full type inference because TypeScript
 * can infer TTool from the tool argument, then apply it to the handler.
 *
 * Works with both raw definitions (from defineIsomorphicTool) and
 * finalized tools (from createIsomorphicTool().build()).
 *
 * @example
 * ```typescript
 * const guessCardHandler = handler(guessTheCardTool, (data, respond) => {
 *   // data.choices, data.secret, etc. are all typed
 *   respond({ guess: data.choices[0] })
 *   return <CardUI choices={data.choices} />
 * })
 * ```
 */
export function handler<TTool extends AnyToolDef>(
  tool: TTool,
  handlerFn: (
    data: HandoffData<TTool>,
    respond: (output: ExtractClientOutput<TTool>) => void
  ) => ReactNode
): TypedHandler<TTool> {
  return { tool, handler: handlerFn }
}

// =============================================================================
// HANDLER REGISTRY
// =============================================================================

/**
 * Registry that holds typed handlers and can render pending handoffs.
 */
export interface ToolHandlerRegistry {
  /**
   * Render all pending handoffs that have handlers.
   * Returns an array of ReactNodes (one per handled handoff).
   */
  render(
    handoffs: PendingHandoff[],
    respond: (callId: string, output: unknown) => void
  ): ReactNode[]

  /**
   * Render a single handoff if we have a handler for it.
   * Returns null if no handler is registered.
   */
  renderOne(
    handoff: PendingHandoff,
    respond: (callId: string, output: unknown) => void
  ): ReactNode | null

  /**
   * Check if a handler is registered for a tool.
   */
  has(toolName: string): boolean

  /**
   * Get the list of tool names that have handlers.
   */
  handledTools(): string[]
}

/**
 * Create a handler registry from an array of typed handlers.
 */
export function createHandlerRegistry(
  handlers: TypedHandler<any>[]
): ToolHandlerRegistry {
  const handlerMap = new Map<
    string,
    (data: unknown, respond: (output: unknown) => void) => ReactNode
  >()

  for (const { tool, handler: handlerFn } of handlers) {
    if (handlerMap.has(tool.name)) {
      throw new Error(`Duplicate handler for tool: "${tool.name}"`)
    }
    handlerMap.set(tool.name, handlerFn)
  }

  return {
    render(handoffs, respond) {
      return handoffs
        .map((h) => this.renderOne(h, respond))
        .filter((node): node is ReactNode => node !== null)
    },

    renderOne(handoff, respond) {
      const handlerFn = handlerMap.get(handoff.toolName)
      if (!handlerFn) return null

      return handlerFn(handoff.data, (output) => {
        respond(handoff.callId, output)
      })
    },

    has(toolName) {
      return handlerMap.has(toolName)
    },

    handledTools() {
      return Array.from(handlerMap.keys())
    },
  }
}

// =============================================================================
// BUILDER PATTERN
// =============================================================================

/**
 * Builder for creating a ToolHandlerRegistry with a fluent API.
 */
export interface ToolHandlerBuilder {
  /**
   * Add a handler for a tool.
   *
   * Works with both raw definitions (from defineIsomorphicTool) and
   * finalized tools (from createIsomorphicTool().build()).
   *
   * @param tool - The isomorphic tool to handle
   * @param handlerFn - Function that receives typed data and respond callback, returns ReactNode
   * @returns The builder for chaining
   */
  add<TTool extends AnyToolDef>(
    tool: TTool,
    handlerFn: (
      data: HandoffData<TTool>,
      respond: (output: ExtractClientOutput<TTool>) => void
    ) => ReactNode
  ): ToolHandlerBuilder

  /**
   * Build the handler registry.
   */
  build(): ToolHandlerRegistry
}

/**
 * Create a tool handler registry using the builder pattern.
 *
 * This provides a fluent API with full type inference at each .add() call site.
 * Works with both raw definitions (from defineIsomorphicTool) and
 * finalized tools (from createIsomorphicTool().build()).
 *
 * @example
 * ```typescript
 * const toolHandlers = createToolHandlers()
 *   .add(guessTheCardTool, (data, respond) => {
 *     // data is typed: { secret, choices, hint, prompt, secretColor }
 *     return <CardPicker choices={data.choices} onPick={(card) => respond({ guess: card })} />
 *   })
 *   .add(askYesNoTool, (data, respond) => {
 *     // data is typed: { question, context? }
 *     return <YesNoDialog question={data.question} onAnswer={(yes) => respond({ answer: yes, question: data.question })} />
 *   })
 *   .build()
 * ```
 */
export function createToolHandlers(): ToolHandlerBuilder {
  const handlers: TypedHandler<any>[] = []

  const builder: ToolHandlerBuilder = {
    add<TTool extends AnyToolDef>(
      tool: TTool,
      handlerFn: (
        data: HandoffData<TTool>,
        respond: (output: ExtractClientOutput<TTool>) => void
      ) => ReactNode
    ) {
      // Cast to any to allow heterogeneous handlers in array
      // Type safety is preserved at call site via TTool inference
      handlers.push({ tool, handler: handlerFn as any })
      return builder
    },

    build(): ToolHandlerRegistry {
      return createHandlerRegistry(handlers)
    },
  }

  return builder
}

// =============================================================================
// TYPE NARROWING HELPER
// =============================================================================

/**
 * Type guard to narrow a PendingHandoff to a specific tool's types.
 *
 * This is useful for manual rendering without the registry pattern.
 * Works with both raw definitions and finalized tools.
 *
 * @example
 * ```typescript
 * function ManualRender({ handoff }: { handoff: PendingHandoff }) {
 *   if (isHandoffFor(handoff, guessTheCardTool)) {
 *     // handoff.data is now typed as { secret, choices, hint, prompt, secretColor }
 *     return <CardPicker choices={handoff.data.choices} />
 *   }
 *   if (isHandoffFor(handoff, askYesNoTool)) {
 *     // handoff.data is now typed as { question, context? }
 *     return <YesNoDialog question={handoff.data.question} />
 *   }
 *   return null
 * }
 * ```
 */
export function isHandoffFor<TTool extends AnyToolDef>(
  handoff: PendingHandoff,
  tool: TTool
): handoff is PendingHandoff & { data: HandoffData<TTool> } {
  return handoff.toolName === tool.name
}
