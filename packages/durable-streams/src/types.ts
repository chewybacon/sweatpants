import type { Operation, Stream } from 'effection'

export class StaleTokenWriterError extends Error {
  readonly code = 'stale_token_writer'

  constructor(message = 'TokenBuffer writer fence is stale') {
    super(message)
    this.name = 'StaleTokenWriterError'
  }
}

export type SessionStatus =
  | 'streaming'
  | 'complete'
  | 'aborted'
  | 'error'
  | 'timeout'
  | 'orphaned'

export interface TokenWriterFence {
  readonly streamId: string
  readonly ownerId: string
  readonly activationEpoch: number
}

/** A mutation-only view bound to one claimed activation epoch. */
export interface TokenBufferWriter<T> {
  readonly fence: TokenWriterFence
  append(tokens: T[]): Operation<number>
  complete(): Operation<void>
  fail(error: Error): Operation<void>
}

export interface TokenBuffer<T> {
  readonly id: string
  /**
   * Claims the mutation lane. A higher epoch permanently fences every older
   * writer, including writers held by another process.
   */
  claimWriter(request: {
    ownerId: string
    activationEpoch: number
  }): Operation<TokenBufferWriter<T>>
  /** Compatibility mutation surface for unfenced, process-local consumers. */
  append(tokens: T[]): Operation<number>
  complete(): Operation<void>
  fail(error: Error): Operation<void>
  read(afterLSN?: number): Operation<{ tokens: T[]; lsn: number }>
  isComplete(): Operation<boolean>
  getError(): Operation<Error | null>
  waitForChange(afterLSN: number): Operation<void>
}

export interface TokenBufferStore<T> {
  create(id: string): Operation<TokenBuffer<T>>
  get(id: string): Operation<TokenBuffer<T> | null>
  delete(id: string): Operation<void>
}

export interface Session<T> {
  readonly id: string
  readonly buffer: TokenBuffer<T>
  status(): Operation<SessionStatus>
  getError(): Operation<Error | null>
  abort(): Operation<void>
}

export interface SessionStore<T> {
  set(session: Session<T>): Operation<void>
  get(sessionId: string): Operation<Session<T> | null>
  delete(sessionId: string): Operation<void>
}

export interface CreateSessionOptions<T> {
  /**
   * The sole eager source consumed by the session writer. A factory receives
   * the Host-owned response buffer so crank-scoped activity can be appended
   * directly without an intermediate queue.
   */
  source?:
    | Stream<T, void>
    | ((buffer: TokenBuffer<T>, writer: TokenBufferWriter<T>) => Stream<T, void>)
  /** Host activation identity used to fence the sole source writer. */
  writer?: { ownerId: string; activationEpoch: number }
  timeoutMs?: number
}

export type RetentionPolicy =
  | { mode: 'auto_delete_on_close' }
  | { mode: 'retain_forever' }
  | { mode: 'retain_until_ttl'; ttlMs: number }

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  mode: 'auto_delete_on_close',
}

export interface SessionManager<T> {
  getOrCreate(sessionId: string, options?: CreateSessionOptions<T>): Operation<Session<T>>
  delete(sessionId: string): Operation<void>
}

export interface SessionManagerConfig<T> {
  bufferStore: TokenBufferStore<T>
  sessionStore?: SessionStore<T>
}

export interface TokenFrame<T> {
  token: T
  lsn: number
}

export interface PullStreamOptions {
  startLSN?: number
}

export type CreatePullStream = <T>(
  buffer: TokenBuffer<T>,
  options?: PullStreamOptions
) => Operation<Stream<TokenFrame<T>, void>>

export interface SessionHandle<T> {
  readonly id: string
  readonly buffer: TokenBuffer<T>
  status(): Operation<SessionStatus>
}

export interface SessionEntry {
  refCount: number
  createdAt: number
}

export interface SessionRegistryStore {
  get(sessionId: string): Operation<SessionEntry | null>
  set(sessionId: string, entry: SessionEntry): Operation<void>
  delete(sessionId: string): Operation<void>
  updateRefCount(sessionId: string, delta: number): Operation<number>
}

export interface RecoverSessionOptions<T> {
  /** Newer Host activation identity required to reclaim the source writer. */
  writer: { ownerId: string; activationEpoch: number }
  /** Constructed only after the writer fence is successfully claimed. */
  recoverSource: (
    buffer: TokenBuffer<T>,
    writer: TokenBufferWriter<T>,
  ) => Stream<T, void>
}

export interface SessionRegistry<T> {
  acquire(sessionId: string, options?: CreateSessionOptions<T>): Operation<SessionHandle<T>>
  release(sessionId: string): Operation<void>
}

export interface RecoverableSessionRegistry<T> extends SessionRegistry<T> {
  recover(sessionId: string, options: RecoverSessionOptions<T>): Operation<SessionHandle<T>>
}
