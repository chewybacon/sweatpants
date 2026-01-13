/**
 * lib/chat/session/contexts.ts
 *
 * Effection contexts for dependency injection in the chat runtime.
 *
 * These contexts allow dependencies to be provided at the scope level
 * rather than passed through every function call. This enables:
 *
 * 1. **Easier testing** - Set mock contexts at test scope
 * 2. **Cleaner APIs** - No props drilling through session/streamer
 * 3. **Flexibility** - Override per-request or per-session
 *
 * ## Usage
 *
 * ```typescript
 * // Provide at session creation
 * yield* BaseUrlContext.set('https://api.example.com/chat')
 * yield* StreamerContext.set(myCustomStreamer)
 *
 * // Consume anywhere in the operation tree
 * const baseUrl = yield* BaseUrlContext
 * const streamer = yield* StreamerContext
 * ```
 *
 * ## Testing
 *
 * ```typescript
 * await run(function* () {
 *   // Provide test doubles
 *   yield* StreamerContext.set(mockStreamer)
 *   yield* ToolRegistryContext.set(mockRegistry)
 *
 *   // Run session - uses mocks automatically
 *   yield* runChatSession(...)
 * })
 * ```
 */
import { createContext } from 'effection'
import type { Context } from 'effection'
import type { Streamer } from './options.ts'
import type { IsomorphicToolRegistry } from '../isomorphic-tools/index.ts'

// =============================================================================
// BASE URL CONTEXT
// =============================================================================

/**
 * Context for the chat API base URL.
 *
 * Default: '/api/chat'
 *
 * @example
 * ```typescript
 * // Provide
 * yield* BaseUrlContext.set('https://api.example.com/chat')
 *
 * // Consume
 * const baseUrl = yield* BaseUrlContext
 * ```
 */
export const BaseUrlContext: Context<string> = createContext<string>(
  'chat:baseUrl',
  '/api/chat'
)

// =============================================================================
// STREAMER CONTEXT
// =============================================================================

/**
 * Context for the chat streamer function.
 *
 * The streamer is responsible for making the actual API request and
 * converting the response into a stream of patches.
 *
 * Default: undefined (uses streamChatOnce)
 *
 * @example
 * ```typescript
 * // In tests - provide a mock streamer
 * const { streamer, controls } = createTestStreamer()
 * yield* StreamerContext.set(streamer)
 *
 * // In production - typically not set, uses default
 * ```
 */
export const StreamerContext: Context<Streamer | undefined> = createContext<
  Streamer | undefined
>('chat:streamer', undefined)

// =============================================================================
// TOOL REGISTRY CONTEXT
// =============================================================================

/**
 * Context for the isomorphic tool registry.
 *
 * Provides access to registered tools anywhere in the operation tree
 * without passing through every function.
 *
 * Default: undefined (no tools)
 *
 * @example
 * ```typescript
 * // Provide at session creation
 * yield* ToolRegistryContext.set(myRegistry)
 *
 * // Consume in tool execution
 * const registry = yield* ToolRegistryContext.get()
 * if (registry) {
 *   const tool = registry.get('calculator')
 * }
 * ```
 */
export const ToolRegistryContext: Context<IsomorphicToolRegistry | undefined> =
  createContext<IsomorphicToolRegistry | undefined>('chat:toolRegistry', undefined)
