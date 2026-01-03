/**
 * Durable Streams Module
 *
 * Provides server-side durable streaming with:
 * - Token buffer storage (append-only log)
 * - Session management with refCount-based lifecycle
 * - Multi-client support (fan-out via pull-based readers)
 * - Reconnection from last LSN (Log Sequence Number)
 * - Web Stream bridge for HTTP responses
 *
 * @example
 * ```typescript
 * import {
 *   createInMemoryBufferStore,
 *   createInMemoryRegistryStore,
 *   createSessionRegistry,
 *   createWebStreamFromBuffer,
 * } from './durable-streams'
 *
 * // At server startup
 * const bufferStore = createInMemoryBufferStore()
 * const registryStore = createInMemoryRegistryStore()
 * const registry = yield* createSessionRegistry(bufferStore, registryStore)
 *
 * // In request handler
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * yield* ensure(() => registry.release(sessionId))
 *
 * const scope = yield* useScope()
 * const webStream = createWebStreamFromBuffer(scope, session.buffer)
 * return new Response(webStream, {
 *   headers: { 'content-type': 'application/x-ndjson' }
 * })
 * ```
 */

// Types
export type {
  SessionStatus,
  TokenBuffer,
  TokenBufferStore,
  Session,
  SessionStore,
  CreateSessionOptions,
  SessionManager,
  SessionManagerConfig,
  TokenFrame,
  PullStreamOptions,
  CreatePullStream,
  SessionHandle,
  SessionEntry,
  SessionRegistryStore,
  SessionRegistry,
} from './types'

// In-memory implementations
export {
  createInMemoryBuffer,
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
} from './in-memory-store'

// Pull stream
export { createPullStream, writeFromStreamToBuffer } from './pull-stream'

// Session registry
export { createSessionRegistry } from './session-registry'

// Web stream bridge
export { createWebStreamFromBuffer } from './web-stream-bridge'
