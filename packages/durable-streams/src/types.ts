import type { Operation, Stream } from 'effection'

export type SessionStatus =
  | 'streaming'
  | 'complete'
  | 'aborted'
  | 'error'
  | 'timeout'
  | 'orphaned'

export interface TokenBuffer<T> {
  readonly id: string
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
  source?: Stream<T, void>
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

export interface SessionRegistry<T> {
  acquire(sessionId: string, options?: CreateSessionOptions<T>): Operation<SessionHandle<T>>
  release(sessionId: string): Operation<void>
}
