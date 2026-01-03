/**
 * Typed Accessor Operations for Durable Streams Contexts
 *
 * These operations provide type-safe access to durable streams contexts
 * with helpful error messages when contexts are not configured.
 *
 * @example
 * ```typescript
 * // Setup first (typically at server startup)
 * yield* setupInMemoryDurableStreams<string>()
 *
 * // Then use anywhere in the operation tree
 * const registry = yield* useSessionRegistry<string>()
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * ```
 */
import type { Operation } from 'effection'
import type { TokenBufferStore, SessionRegistryStore, SessionRegistry } from './types'
import {
  TokenBufferStoreContext,
  SessionRegistryStoreContext,
  SessionRegistryContext,
} from './contexts'

// =============================================================================
// USE TOKEN BUFFER STORE
// =============================================================================

/**
 * Get the TokenBufferStore from context with type safety.
 *
 * @throws Error if TokenBufferStore is not configured
 *
 * @example
 * ```typescript
 * const bufferStore = yield* useTokenBufferStore<string>()
 * const buffer = yield* bufferStore.create('session-123')
 * ```
 */
export function* useTokenBufferStore<T>(): Operation<TokenBufferStore<T>> {
  const store = yield* TokenBufferStoreContext.get()
  if (!store) {
    throw new Error(
      'TokenBufferStore not configured. ' +
        'Call setupDurableStreams() or set TokenBufferStoreContext before use.'
    )
  }
  return store as TokenBufferStore<T>
}

// =============================================================================
// USE SESSION REGISTRY STORE
// =============================================================================

/**
 * Get the SessionRegistryStore from context with type safety.
 *
 * @throws Error if SessionRegistryStore is not configured
 *
 * @example
 * ```typescript
 * const registryStore = yield* useSessionRegistryStore<string>()
 * const entry = yield* registryStore.get('session-123')
 * ```
 */
export function* useSessionRegistryStore<T>(): Operation<SessionRegistryStore<T>> {
  const store = yield* SessionRegistryStoreContext.get()
  if (!store) {
    throw new Error(
      'SessionRegistryStore not configured. ' +
        'Call setupDurableStreams() or set SessionRegistryStoreContext before use.'
    )
  }
  return store as SessionRegistryStore<T>
}

// =============================================================================
// USE SESSION REGISTRY
// =============================================================================

/**
 * Get the SessionRegistry from context with type safety.
 *
 * This is the primary accessor most consumers will use.
 *
 * @throws Error if SessionRegistry is not configured
 *
 * @example
 * ```typescript
 * const registry = yield* useSessionRegistry<string>()
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * yield* ensure(() => registry.release(sessionId))
 * ```
 */
export function* useSessionRegistry<T>(): Operation<SessionRegistry<T>> {
  const registry = yield* SessionRegistryContext.get()
  if (!registry) {
    throw new Error(
      'SessionRegistry not configured. ' +
        'Call setupDurableStreams() or set SessionRegistryContext before use.'
    )
  }
  return registry as SessionRegistry<T>
}
