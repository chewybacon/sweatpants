/**
 * Durable Streams Module
 *
 * Provides server-side durable streaming with:
 * - Token buffer storage (append-only log)
 * - Session management with refCount-based lifecycle
 * - Multi-client support (fan-out via pull-based readers)
 * - Reconnection from last LSN (Log Sequence Number)
 * - Web Stream bridge for HTTP responses
 * - IoC/DI via scoped ports
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
 * // At server startup - installs the durable-streams drivers
 * yield* setupInMemoryDurableStreams<string>()
 *
 * // In request handler - resolve through the port
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
  TokenBufferWriter,
  TokenWriterFence,
  CreateSessionOptions,
  TokenFrame,
  SessionHandle,
  SessionEntry,
  SessionRegistryStore,
  SessionRegistry,
  RecoverableSessionRegistry,
  RecoverSessionOptions,
  RetentionPolicy,
  PullStreamOptions,
} from "@sweatpants/durable-streams";

export {
  DEFAULT_RETENTION_POLICY,
  createInMemoryBuffer,
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  createPullStream,
  writeFromStreamToBuffer,
} from "@sweatpants/durable-streams";

// Redis store is imported from the `/redis` subpath at consumer sites that
// need it (e.g. tool-runtime-agentcore). It is not re-exported here to avoid
// pulling `redis` into the install graph of packages that only need the
// in-memory substrate. See REQ-060 / NFR-012.

// Web stream bridge
export { createWebStreamFromBuffer } from "./web-stream-bridge.ts";

// =============================================================================
// IoC/DI - Contexts, Accessors, and Setup Helpers
// =============================================================================

// Scope-bound typed accessors over the durable-streams ports.
export {
  useTokenBufferStore,
  useSessionRegistryStore,
  useSessionRegistry,
} from "@sweatpants/durable-streams";

// Setup helpers (recommended entry point)
export {
  setupDurableStreams,
  setupInMemoryDurableStreams,
  type DurableStreamsConfig,
  type DurableStreamsSetup,
} from "./setup.ts";

// Shared memory store (for cross-scope persistence in tests and single-server deployments)
export {
  createEmptyChatEngine,
  createSerializedEventStream,
  type ChatEngineSource,
  type TurnEventSink,
} from "./event-stream.ts";

export {
  getConversationCheckpointId,
  getConversationIndexId,
  recordConversationCheckpoint,
  recordConversationSession,
  readLatestConversationCheckpoint,
  resolveLatestConversationSession,
} from "./conversation-index.ts";

export {
  createSharedStorage,
  createSharedBufferStore,
  createSharedRegistryStore,
  getSharedStores,
  type SharedStorage,
  type SharedBufferState,
  type SharedDurableStreamsConfig,
} from "./shared-memory-store.ts";

export {
  createDurableTurnOwner,
  installDurableStreamsOwner,
  useDurableStreamsOwner,
  type DurableStreamsOwner,
  type DurableTurnHost,
  type DurableTurnOwner,
} from "./owner.ts";
