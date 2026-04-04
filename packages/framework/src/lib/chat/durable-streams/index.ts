/**
 * Durable Streams Module
 *
 * Provides server-side durable streaming with:
 * - Token buffer storage (append-only log)
 * - Session management with refCount-based lifecycle
 * - Multi-client support (fan-out via pull-based readers)
 * - Reconnection from last LSN (Log Sequence Number)
 * - Web Stream bridge for HTTP responses
 * - IoC/DI via Effection contexts
 *
 * ## Quick Start (with DI)
 *
 * @example
 * ```typescript
 * import {
 *   setupInMemoryDurableStreams,
 *   useSessionRegistry,
 *   createWebStreamFromBuffer,
 * } from './durable-streams'
 *
 * // At server startup - sets up contexts for DI
 * yield* setupInMemoryDurableStreams<string>()
 *
 * // In request handler - access via context
 * const registry = yield* useSessionRegistry<string>()
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * yield* ensure(() => registry.release(sessionId))
 *
 * const scope = yield* useScope()
 * const webStream = createWebStreamFromBuffer(scope, session.buffer)
 * return new Response(webStream, {
 *   headers: { 'content-type': 'application/x-ndjson' }
 * })
 * ```
 *
 * ## Manual Setup (without DI)
 *
 * @example
 * ```typescript
 * import {
 *   createInMemoryBufferStore,
 *   createInMemoryRegistryStore,
 *   createSessionRegistry,
 * } from './durable-streams'
 *
 * const bufferStore = createInMemoryBufferStore()
 * const registryStore = createInMemoryRegistryStore()
 * const registry = yield* createSessionRegistry(bufferStore, registryStore)
 * ```
 */

// Re-exports from @sweatpants/durable-streams
export type {
  SessionStatus,
  TokenBuffer,
  TokenBufferStore,
  Session,
  CreateSessionOptions,
  TokenFrame,
  SessionHandle,
  SessionEntry,
  SessionRegistryStore,
  SessionRegistry,
  RetentionPolicy,
  PullStreamOptions,
} from '@sweatpants/durable-streams'

export {
  DEFAULT_RETENTION_POLICY,
  createInMemoryBuffer,
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  createPullStream,
  writeFromStreamToBuffer,
  createRedisTokenBufferStore,
  type RedisTokenBufferStore,
} from '@sweatpants/durable-streams'

// Session registry (framework-specific orchestration)
export { createSessionRegistry } from './session-registry.ts'

// Web stream bridge
export { createWebStreamFromBuffer } from './web-stream-bridge.ts'

// =============================================================================
// IoC/DI - Contexts, Accessors, and Setup Helpers
// =============================================================================

// Contexts (raw Effection contexts for advanced use)
export {
  TokenBufferStoreContext,
  SessionRegistryStoreContext,
  SessionRegistryContext,
} from './contexts.ts'

// Typed accessor operations (recommended for most use)
export {
  useTokenBufferStore,
  useSessionRegistryStore,
  useSessionRegistry,
} from './use.ts'

// Setup helpers (recommended entry point)
export {
  setupDurableStreams,
  setupInMemoryDurableStreams,
  type DurableStreamsConfig,
  type DurableStreamsSetup,
} from './setup.ts'

// Shared memory store (for cross-scope persistence in tests and single-server deployments)
export {
  createSharedStorage,
  createSharedBufferStore,
  createSharedRegistryStore,
  getSharedStores,
  type SharedStorage,
  type SharedBufferState,
  type SharedDurableStreamsConfig,
} from './shared-memory-store.ts'
