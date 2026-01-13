/**
 * Effection Contexts for Durable Streams DI
 *
 * Enables dependency injection of storage backends and session management.
 * These contexts use `unknown` as the base type to support generics - use the
 * typed accessor operations in `use.ts` for type-safe access.
 *
 * @example
 * ```typescript
 * // Setup (server startup)
 * yield* TokenBufferStoreContext.set(createInMemoryBufferStore())
 * yield* SessionRegistryStoreContext.set(createInMemoryRegistryStore())
 * yield* SessionRegistryContext.set(yield* createSessionRegistry(...))
 *
 * // Usage (request handler) - prefer useSessionRegistry<T>() from use.ts
 * const registry = yield* SessionRegistryContext.get()
 * ```
 *
 * @see {@link ./use.ts} for typed accessor operations
 * @see {@link ./setup.ts} for setup helpers
 */
import { createContext } from 'effection'
import type { Context } from 'effection'
import type { TokenBufferStore, SessionRegistryStore, SessionRegistry } from './types.ts'

// =============================================================================
// TOKEN BUFFER STORE CONTEXT
// =============================================================================

/**
 * Context for the TokenBufferStore.
 *
 * The buffer store is responsible for creating, retrieving, and deleting
 * token buffers. Different implementations can be used for different
 * storage backends (in-memory, Redis, Postgres, etc.).
 *
 * Default: undefined (must be configured before use)
 *
 * @example
 * ```typescript
 * // Provide at server startup
 * yield* TokenBufferStoreContext.set(createInMemoryBufferStore())
 *
 * // Or use setupDurableStreams() which sets all contexts
 * yield* setupInMemoryDurableStreams()
 * ```
 */
export const TokenBufferStoreContext: Context<TokenBufferStore<unknown> | undefined> =
  createContext<TokenBufferStore<unknown> | undefined>(
    'durable-streams:bufferStore',
    undefined
  )

// =============================================================================
// SESSION REGISTRY STORE CONTEXT
// =============================================================================

/**
 * Context for the SessionRegistryStore.
 *
 * The registry store tracks session entries with refCount for lifecycle
 * management. Different implementations can be used for single-server
 * (in-memory) or multi-server (Redis) deployments.
 *
 * Default: undefined (must be configured before use)
 *
 * @example
 * ```typescript
 * // Provide at server startup
 * yield* SessionRegistryStoreContext.set(createInMemoryRegistryStore())
 *
 * // Or use setupDurableStreams() which sets all contexts
 * yield* setupInMemoryDurableStreams()
 * ```
 */
export const SessionRegistryStoreContext: Context<SessionRegistryStore<unknown> | undefined> =
  createContext<SessionRegistryStore<unknown> | undefined>(
    'durable-streams:registryStore',
    undefined
  )

// =============================================================================
// SESSION REGISTRY CONTEXT
// =============================================================================

/**
 * Context for the SessionRegistry.
 *
 * The registry manages session lifecycle with acquire/release semantics.
 * This is the primary context most consumers will use.
 *
 * Default: undefined (must be configured before use)
 *
 * @example
 * ```typescript
 * // Setup
 * yield* setupInMemoryDurableStreams()
 *
 * // Usage (prefer useSessionRegistry<T>() for type safety)
 * const registry = yield* useSessionRegistry<string>()
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * ```
 */
export const SessionRegistryContext: Context<SessionRegistry<unknown> | undefined> =
  createContext<SessionRegistry<unknown> | undefined>(
    'durable-streams:registry',
    undefined
  )
