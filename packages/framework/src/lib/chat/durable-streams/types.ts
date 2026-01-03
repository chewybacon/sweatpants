/**
 * Durable Streams Types
 *
 * Defines interfaces for server-side durable streaming with:
 * - Token buffer storage (append-only log)
 * - Session management (lifecycle, abort, timeout)
 * - Multi-client support (fan-out via pull-based readers)
 *
 * Design principles:
 * - Effection Operations as the async primitive
 * - Decoupled read/write interfaces
 * - Adapter pattern for storage backends
 * - Pull-based streaming with backpressure
 */
import type { Operation, Stream } from 'effection'

// =============================================================================
// SESSION STATUS
// =============================================================================

export type SessionStatus =
  | 'streaming' // Active LLM stream writing to buffer
  | 'complete' // LLM finished, buffer has all tokens
  | 'aborted' // User explicitly aborted
  | 'error' // LLM or system error
  | 'timeout' // Watchdog killed it
  | 'orphaned' // Buffer exists but no active writer (rehydrated, incomplete)

// =============================================================================
// TOKEN BUFFER (Durable Storage)
// =============================================================================

/**
 * Append-only token buffer. Source of truth for a stream.
 *
 * Implementations:
 * - In-memory (dev): Uses effection Channel for waitForChange
 * - Redis (prod): Uses pub/sub for waitForChange
 * - Postgres (prod): Uses LISTEN/NOTIFY for waitForChange
 * - SQLite: Polls (no native notify)
 */
export interface TokenBuffer<T> {
  readonly id: string

  // Write side
  append(tokens: T[]): Operation<number> // returns LSN
  complete(): Operation<void>
  fail(error: Error): Operation<void>

  // Read side
  read(afterLSN?: number): Operation<{ tokens: T[]; lsn: number }>
  isComplete(): Operation<boolean>
  getError(): Operation<Error | null>

  // Wait mechanism (adapter-specific: channel, pub/sub, poll)
  waitForChange(afterLSN: number): Operation<void>
}

/**
 * Factory/store for TokenBuffers.
 * Manages creation, lookup, and cleanup.
 */
export interface TokenBufferStore<T> {
  create(id: string): Operation<TokenBuffer<T>>
  get(id: string): Operation<TokenBuffer<T> | null>
  delete(id: string): Operation<void>
}

// =============================================================================
// SESSION (Ephemeral Handle)
// =============================================================================

/**
 * Session handle for a durable stream.
 *
 * Sessions are ephemeral (in-memory) handles that reference
 * a durable TokenBuffer. Multiple sessions can reference the
 * same buffer (multi-device, reconnect scenarios).
 */
export interface Session<T> {
  readonly id: string
  readonly buffer: TokenBuffer<T>

  status(): Operation<SessionStatus>
  getError(): Operation<Error | null>

  abort(): Operation<void>
}

// =============================================================================
// SESSION STORE (In-Memory by Default)
// =============================================================================

/**
 * In-memory session handle storage.
 * Sessions are ephemeral - this just tracks active handles.
 */
export interface SessionStore<T> {
  set(session: Session<T>): Operation<void>
  get(sessionId: string): Operation<Session<T> | null>
  delete(sessionId: string): Operation<void>
}

// =============================================================================
// SESSION MANAGER (Orchestrator)
// =============================================================================

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions<T> {
  source?: Stream<T, void> // LLM token stream (required for new sessions)
  timeoutMs?: number // Watchdog timeout
}

/**
 * Manages session lifecycle: create, rehydrate, abort.
 *
 * Key method is getOrCreate which handles:
 * - Returning cached session handle (same server, still running)
 * - Rehydrating session from existing buffer (reconnect, different server)
 * - Creating new session with LLM stream (initial request)
 */
export interface SessionManager<T> {
  getOrCreate(
    sessionId: string,
    options?: CreateSessionOptions<T>
  ): Operation<Session<T>>

  delete(sessionId: string): Operation<void>
}

/**
 * Configuration for SessionManager.
 */
export interface SessionManagerConfig<T> {
  bufferStore: TokenBufferStore<T>
  sessionStore?: SessionStore<T> // defaults to in-memory
}

// =============================================================================
// PULL STREAM (Client Reader)
// =============================================================================

/**
 * A token with its LSN (Log Sequence Number).
 * Returned by pull streams so clients can track their position
 * for reconnect scenarios.
 */
export interface TokenFrame<T> {
  token: T
  lsn: number
}

/**
 * Creates a pull-based stream for a client reading from a buffer.
 *
 * Each client gets their own cursor into the shared buffer.
 * The stream yields TokenFrames (token + LSN) as they become available,
 * with natural backpressure (client controls read pace).
 */
export interface PullStreamOptions {
  startLSN?: number
}

/**
 * A pull-based stream that reads from a TokenBuffer.
 * This is what each client connection uses to receive tokens.
 * Returns TokenFrame<T> so clients can track LSN for reconnect.
 */
export type CreatePullStream = <T>(
  buffer: TokenBuffer<T>,
  options?: PullStreamOptions
) => Operation<Stream<TokenFrame<T>, void>>

// =============================================================================
// SESSION REGISTRY (Lifecycle Management)
// =============================================================================

/**
 * What clients get when they acquire a session.
 * Does NOT expose lifecycle control - registry manages that.
 */
export interface SessionHandle<T> {
  readonly id: string
  readonly buffer: TokenBuffer<T>
  status(): Operation<SessionStatus>
}

/**
 * Entry stored in the registry store.
 */
export interface SessionEntry<T> {
  handle: SessionHandle<T>
  refCount: number
  createdAt: number
}

/**
 * Pluggable storage backend for session entries.
 * In-memory for single server, Redis/etc for multi-server.
 */
export interface SessionRegistryStore<T> {
  get(sessionId: string): Operation<SessionEntry<T> | null>
  set(sessionId: string, entry: SessionEntry<T>): Operation<void>
  delete(sessionId: string): Operation<void>
  updateRefCount(sessionId: string, delta: number): Operation<number> // returns new count
}

/**
 * Session Registry - manages session lifecycle with refCount.
 *
 * Usage:
 *   const session = yield* registry.acquire(sessionId, { source: llmStream })
 *   yield* ensure(() => registry.release(sessionId))
 *   // ... use session.buffer ...
 *
 * Lifecycle:
 * - acquire: Creates or returns existing session, increments refCount
 * - release: Decrements refCount, cleans up when refCount=0 AND complete
 *
 * Key behaviors:
 * - LLM writer survives client disconnect (runs in registry's scope)
 * - Buffer persists for reconnect while LLM is still streaming
 * - Automatic cleanup when all clients release AND stream completes
 */
export interface SessionRegistry<T> {
  /**
   * Get or create a session, incrementing refCount.
   * If session doesn't exist and options.source is provided, spawns LLM writer.
   */
  acquire(
    sessionId: string,
    options?: CreateSessionOptions<T>
  ): Operation<SessionHandle<T>>

  /**
   * Decrement refCount. If refCount=0 and session complete, cleanup.
   * If still streaming, defers cleanup until completion.
   */
  release(sessionId: string): Operation<void>
}
