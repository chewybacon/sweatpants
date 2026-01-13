/**
 * Setup Helpers for Durable Streams
 *
 * Provides convenient functions to configure the durable streams infrastructure.
 * These helpers create the necessary stores and registry, then set the contexts
 * so they're available throughout the operation tree.
 *
 * @example
 * ```typescript
 * // Development/Testing: Use in-memory stores
 * yield* setupInMemoryDurableStreams<string>()
 *
 * // Production: Use custom stores (e.g., Redis)
 * yield* setupDurableStreams({
 *   bufferStore: createRedisBufferStore(),
 *   registryStore: createRedisRegistryStore(),
 * })
 *
 * // Then use anywhere
 * const registry = yield* useSessionRegistry<string>()
 * ```
 */
import type { Operation } from 'effection'
import type { SessionRegistry, TokenBufferStore, SessionRegistryStore } from './types.ts'
import { createInMemoryBufferStore, createInMemoryRegistryStore } from './in-memory-store.ts'
import { createSessionRegistry } from './session-registry.ts'
import {
  TokenBufferStoreContext,
  SessionRegistryStoreContext,
  SessionRegistryContext,
} from './contexts.ts'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for setting up durable streams with custom stores.
 */
export interface DurableStreamsConfig<T> {
  /** Store for creating and managing TokenBuffers */
  bufferStore: TokenBufferStore<T>
  /** Store for tracking session entries with refCount */
  registryStore: SessionRegistryStore<T>
}

/**
 * Result from setup operations, providing access to all created components.
 */
export interface DurableStreamsSetup<T> {
  /** The session registry for acquire/release operations */
  registry: SessionRegistry<T>
  /** The buffer store (also available via useTokenBufferStore) */
  bufferStore: TokenBufferStore<T>
  /** The registry store (also available via useSessionRegistryStore) */
  registryStore: SessionRegistryStore<T>
}

// =============================================================================
// SETUP WITH CUSTOM STORES
// =============================================================================

/**
 * Setup durable streams with provided stores.
 *
 * Creates the SessionRegistry and sets all contexts so they're available
 * via the `use*` accessor operations.
 *
 * @param config - Configuration with custom buffer and registry stores
 * @returns Setup result with registry and stores
 *
 * @example
 * ```typescript
 * // Production with Redis
 * const setup = yield* setupDurableStreams({
 *   bufferStore: createRedisBufferStore(redisClient),
 *   registryStore: createRedisRegistryStore(redisClient),
 * })
 *
 * // Access via context anywhere
 * const registry = yield* useSessionRegistry<string>()
 * ```
 */
export function* setupDurableStreams<T>(
  config: DurableStreamsConfig<T>
): Operation<DurableStreamsSetup<T>> {
  const { bufferStore, registryStore } = config

  // Create the registry (this is an Operation that may spawn tasks)
  const registry = yield* createSessionRegistry(bufferStore, registryStore)

  // Set all contexts for DI
  yield* TokenBufferStoreContext.set(bufferStore as TokenBufferStore<unknown>)
  yield* SessionRegistryStoreContext.set(registryStore as SessionRegistryStore<unknown>)
  yield* SessionRegistryContext.set(registry as SessionRegistry<unknown>)

  return { registry, bufferStore, registryStore }
}

// =============================================================================
// SETUP WITH IN-MEMORY STORES
// =============================================================================

/**
 * Setup durable streams with in-memory stores.
 *
 * Convenient for development, testing, and single-server deployments.
 * Creates in-memory buffer and registry stores, then sets all contexts.
 *
 * @returns Setup result with registry and stores
 *
 * @example
 * ```typescript
 * // In tests
 * it('should handle session lifecycle', function* () {
 *   const { registry } = yield* setupInMemoryDurableStreams<string>()
 *
 *   const session = yield* registry.acquire('session-1', {
 *     source: createMockLLMStream('Hello world'),
 *   })
 *   // ...
 * })
 *
 * // Or access via context
 * it('should work with contexts', function* () {
 *   yield* setupInMemoryDurableStreams<string>()
 *
 *   const registry = yield* useSessionRegistry<string>()
 *   // ...
 * })
 * ```
 */
export function* setupInMemoryDurableStreams<T>(): Operation<DurableStreamsSetup<T>> {
  const bufferStore = createInMemoryBufferStore<T>()
  const registryStore = createInMemoryRegistryStore<T>()

  return yield* setupDurableStreams({ bufferStore, registryStore })
}
