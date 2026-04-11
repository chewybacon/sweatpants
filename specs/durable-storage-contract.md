# Durable Storage Contract

- **Status:** Draft
- **Version:** 2026-04-10
- **Companion:** [Durable Stream Protocol](./durable-stream-protocol.md)

## 1. Introduction

This specification defines the storage abstractions that back the
[Durable Stream Protocol](./durable-stream-protocol.md). It covers the
`TokenBuffer`, `TokenBufferStore`, `SessionRegistryStore`, and
`SessionRegistry` interfaces — their behavioral contracts, concurrency
requirements, retention policies, and conformance criteria for pluggable
storage backends.

The protocol spec describes the wire format and transport. This spec
describes the server-side machinery that produces, stores, and manages the
durable event logs that the transport delivers to clients.

### 1.1 Design Goals

1. **Pluggability.** Storage backends are abstracted behind narrow interfaces.
   Implementations range from in-process `Map`s (development) to Redis Streams
   (production) to hypothetical Postgres or S3-backed stores.

2. **Scope independence.** Production storage MUST survive the destruction of
   individual request-scoped Effection contexts. Buffers created during one
   HTTP request MUST be readable from a subsequent request on the same server.

3. **Reference counting.** Multiple concurrent readers (clients, reconnects,
   inspector panels) share a single buffer. The registry tracks live readers
   and applies retention policy only when the last reader releases.

4. **Separation of concerns.** The `TokenBuffer` handles append/read/wait
   mechanics. The `SessionRegistryStore` handles entry metadata and ref
   counting. The `SessionRegistry` orchestrates lifecycle, writer tasks, and
   retention. These are independent, composable layers.

### 1.2 Relationship to the Protocol Spec

The protocol spec references "the server's token buffer" and "session
registry" without defining their internal contract. This spec fills that gap.
A conforming server implementation MUST provide storage that satisfies the
contracts defined here. The protocol spec's transport layer
(`createProtocolReadResponse`, `createProtocolMutationResponse`) consumes
these interfaces directly.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119][rfc2119].

| Term | Definition |
|---|---|
| **Token** | A single unit of storage. For the chat protocol, tokens are serialized JSON strings representing `StreamEvent` objects. The storage layer is generic over `T`. |
| **LSN** | Log Sequence Number. 1-indexed position within a buffer's token array. Assigned by the producer, preserved across reads. See [Protocol Spec §3.1][proto-lsn]. |
| **Buffer** | An append-only, ordered sequence of tokens. Each buffer has a unique `id` (typically a session UUID). Buffers transition through `open → closed` (complete or failed). |
| **Session Entry** | Metadata record for a session: `refCount` (number of active readers) and `createdAt` (epoch timestamp). Stored in the registry store. |
| **Retention Policy** | Strategy that determines when a closed buffer and its registry entry are deleted. Applied when `refCount` reaches zero. |
| **Background Task** | An Effection operation that outlives the scope that spawned it. Writer tasks and cleanup waiters run as background tasks. |

## 3. TokenBuffer\<T\>

A `TokenBuffer<T>` is an append-only, observable log of tokens. It is the
fundamental storage primitive.

### 3.1 Interface

```typescript
interface TokenBuffer<T> {
  readonly id: string
  append(tokens: T[]): Operation<number>
  complete(): Operation<void>
  fail(error: Error): Operation<void>
  read(afterLSN?: number): Operation<{ tokens: T[]; lsn: number }>
  isComplete(): Operation<boolean>
  getError(): Operation<Error | null>
  waitForChange(afterLSN: number): Operation<void>
}
```

### 3.2 Behavioral Contract

#### 3.2.1 `append(tokens)`

- MUST append all tokens atomically to the end of the log.
- MUST return the new total length of the token array.
- MUST throw if the buffer has been completed or failed ("Buffer is closed").
- MUST notify any waiters blocked in `waitForChange`.
- Implementations SHOULD support single-token appends efficiently, as the
  canonical producer (`writeFromStreamToBuffer`) appends one token at a time.

#### 3.2.2 `complete()`

- MUST mark the buffer as complete (closed successfully).
- MUST be idempotent — calling `complete()` on an already-complete buffer
  MUST NOT throw.
- MUST notify any waiters blocked in `waitForChange`.
- After `complete()`, subsequent `append()` calls MUST throw.

#### 3.2.3 `fail(error)`

- MUST mark the buffer as failed with the given error.
- MUST notify any waiters blocked in `waitForChange`.
- After `fail()`, subsequent `append()` calls MUST throw.
- A failed buffer is considered closed. `isComplete()` MAY return `true`
  for a failed buffer (implementation-dependent), but `getError()` MUST
  return the error, which is the authoritative signal.

#### 3.2.4 `read(afterLSN?)`

- MUST return `{ tokens, lsn }` where:
  - `tokens` is a slice of the log starting at index `afterLSN` (0-based
    offset into the token array; defaults to `0`).
  - `lsn` is the current total length of the token array (the high-water
    mark).
- MUST be safe to call concurrently from multiple readers.
- MUST NOT block — returns immediately with whatever data is available.
- When called with `afterLSN` equal to or greater than the current length,
  MUST return an empty `tokens` array and the current `lsn`.

#### 3.2.5 `isComplete()`

- MUST return `true` if `complete()` or `fail()` has been called.
- MUST return `false` if the buffer is still open for appends.

#### 3.2.6 `getError()`

- MUST return the `Error` passed to `fail()`, or `null` if the buffer
  completed successfully or is still open.

#### 3.2.7 `waitForChange(afterLSN)`

- If the current token count exceeds `afterLSN`, or the buffer is complete
  or failed, MUST return immediately.
- Otherwise, MUST block (suspend the Effection operation) until one of:
  - New tokens are appended (token count exceeds `afterLSN`).
  - The buffer is completed.
  - The buffer fails.
- MUST be safe to call from multiple concurrent waiters.

### 3.3 Notification Mechanisms

Implementations MUST provide a notification mechanism for `waitForChange`.
Two patterns are used in the reference implementations:

| Pattern | Used By | Characteristics |
|---|---|---|
| Effection `Signal` | In-memory store | Scope-bound. Destroyed when the creating Effection scope exits. Suitable for tests and single-scope usage. |
| Polling with `sleep(1)` | Shared-memory store | Cross-scope. Works across HTTP request boundaries. Uses cooperative scheduling via Effection's `sleep`. |
| Redis pub/sub or polling | Redis store | Cross-process. Uses in-process `Signal` map for local notification, with Redis `XRANGE` for cross-process consistency. |

Backends that serve production traffic across request scopes MUST NOT rely
on Effection `Signal` alone, as signals are destroyed when their parent scope
exits.

## 4. TokenBufferStore\<T\>

A `TokenBufferStore<T>` is a factory and lookup service for `TokenBuffer`
instances.

### 4.1 Interface

```typescript
interface TokenBufferStore<T> {
  create(id: string): Operation<TokenBuffer<T>>
  get(id: string): Operation<TokenBuffer<T> | null>
  delete(id: string): Operation<void>
}
```

### 4.2 Behavioral Contract

#### 4.2.1 `create(id)`

- MUST create a new, empty, open buffer with the given `id`.
- MUST throw if a buffer with that `id` already exists.
- The returned buffer MUST satisfy all `TokenBuffer<T>` invariants.

#### 4.2.2 `get(id)`

- MUST return the buffer if it exists, or `null` otherwise.
- For backends where the buffer is a stateful object (in-memory), MUST
  return a reference to the same underlying state — not a copy.
- For backends where the buffer is reconstructed from storage (Redis), the
  returned wrapper MUST reflect the current state of the underlying store.

#### 4.2.3 `delete(id)`

- MUST remove the buffer and all its tokens from storage.
- MUST be safe to call for a non-existent `id` (no-op).
- After deletion, `get(id)` MUST return `null`.

## 5. SessionRegistryStore

The `SessionRegistryStore` manages session metadata entries with
reference-counted lifecycle tracking. It is a pure data store — it does not
orchestrate lifecycle (that is the `SessionRegistry`'s job).

### 5.1 Interface

```typescript
interface SessionEntry {
  refCount: number
  createdAt: number
}

interface SessionRegistryStore {
  get(sessionId: string): Operation<SessionEntry | null>
  set(sessionId: string, entry: SessionEntry): Operation<void>
  delete(sessionId: string): Operation<void>
  updateRefCount(sessionId: string, delta: number): Operation<number>
}
```

### 5.2 Behavioral Contract

#### 5.2.1 `get(sessionId)`

- MUST return the entry if it exists, or `null` otherwise.

#### 5.2.2 `set(sessionId, entry)`

- MUST store or overwrite the entry for the given session.
- The `entry` MUST be treated as a mutable reference for in-process stores.
  Stores backed by external systems (Redis, Postgres) MUST serialize and
  deserialize the entry.

#### 5.2.3 `delete(sessionId)`

- MUST remove the entry from storage.
- MUST be safe to call for a non-existent session (no-op).

#### 5.2.4 `updateRefCount(sessionId, delta)`

- MUST atomically add `delta` to the session's `refCount`.
- MUST return the new `refCount` after the update.
- MUST throw if the session does not exist.
- For external stores, this operation MUST be atomic (e.g., Redis `HINCRBY`,
  Postgres `UPDATE ... SET refcount = refcount + $1 RETURNING refcount`).

### 5.3 Serialization Constraint

`SessionEntry` MUST remain serializable as plain JSON (`{ refCount: number,
createdAt: number }`). Implementations MUST NOT store non-serializable state
(functions, handles, event emitters) inside `SessionEntry`. Runtime state
(writer task handles, mutable status) MUST be tracked separately.

## 6. SessionRegistry\<T\>

The `SessionRegistry<T>` is the high-level orchestrator that binds together
buffer storage, registry metadata, writer lifecycle, and retention policy.

### 6.1 Interface

```typescript
interface SessionRegistry<T> {
  acquire(sessionId: string, options?: CreateSessionOptions<T>): Operation<SessionHandle<T>>
  release(sessionId: string): Operation<void>
}

interface SessionHandle<T> {
  readonly id: string
  readonly buffer: TokenBuffer<T>
  status(): Operation<SessionStatus>
}

type SessionStatus =
  | 'streaming'
  | 'complete'
  | 'aborted'
  | 'error'
  | 'timeout'
  | 'orphaned'
```

### 6.2 `acquire(sessionId, options?)`

#### 6.2.1 New Session (No Existing Entry)

When `registryStore.get(sessionId)` returns `null`:

1. The `options.source` stream MUST be provided. If absent, the
   implementation MUST throw (`"Session not found and no source provided"`).
2. The implementation MUST create a new buffer via `bufferStore.create(sessionId)`.
3. The implementation MUST spawn a **background writer task** that pipes
   `options.source` into the buffer using `writeFromStreamToBuffer`.
4. The writer task MUST:
   - Call `buffer.complete()` when the source stream ends normally.
   - Call `buffer.fail(error)` when the source stream throws.
   - Run as a background task that outlives the calling scope (so the LLM
     writer survives client disconnects).
5. The implementation MUST store a `SessionEntry` with `refCount: 1` via
   `registryStore.set(sessionId, entry)`.
6. The implementation MUST return a `SessionHandle` wrapping the buffer.

#### 6.2.2 Existing Session (Entry Found)

When `registryStore.get(sessionId)` returns a non-null entry:

1. The implementation MUST cancel any pending retention task for this
   session (the client is reconnecting before retention fired).
2. The implementation MUST increment `refCount` by 1 via
   `registryStore.updateRefCount(sessionId, 1)`.
3. The implementation MUST look up the existing buffer via
   `bufferStore.get(sessionId)` and throw if the buffer is missing
   (metadata/buffer inconsistency).
4. The implementation MUST return a `SessionHandle` wrapping the existing
   buffer. The `options.source` parameter, if provided, SHOULD be ignored
   — the original writer task is authoritative.

### 6.3 `release(sessionId)`

1. If the session entry does not exist, the implementation MUST return
   silently (no-op).
2. The implementation MUST decrement `refCount` by 1 via
   `registryStore.updateRefCount(sessionId, -1)`.
3. If the new `refCount` is greater than zero, the implementation MUST
   return — other readers are still active.
4. If the new `refCount` is zero:

   **Case A — Writer task is done:**
   The implementation MUST apply the retention policy immediately
   (Section 7).

   **Case B — Writer task is still running:**
   The implementation MUST spawn a background cleanup waiter that:
   1. Waits for the writer task to complete.
   2. Re-checks `refCount` (a client may have reconnected in the meantime).
   3. If `refCount` is still zero, applies the retention policy.
   4. If `refCount` is non-zero, takes no action (client reconnected).

### 6.4 SessionHandle Status Resolution

The `status()` method on `SessionHandle` MUST resolve status in this order:

1. If a mutable runtime state object exists for this session, return its
   `status` field (updated by the writer task: `'streaming'` → `'complete'`
   or `'error'`).
2. If `buffer.getError()` returns non-null, return `'error'`.
3. If `buffer.isComplete()` returns `true`, return `'complete'`.
4. Otherwise, return `'streaming'`.

## 7. Retention Policies

Retention determines when a closed session's durable state (buffer + registry
entry) is deleted. The policy is configured per-registry, not per-session.

### 7.1 Policy Types

```typescript
type RetentionPolicy =
  | { mode: 'auto_delete_on_close' }
  | { mode: 'retain_forever' }
  | { mode: 'retain_until_ttl'; ttlMs: number }
```

The default policy is `auto_delete_on_close`.

### 7.2 `auto_delete_on_close`

Applied when `refCount` reaches zero and the writer task is done.

- If the session **succeeded** (complete, no error): the implementation
  MUST delete both the registry entry and the buffer
  (`registryStore.delete` + `bufferStore.delete`), then clean up runtime
  state.
- If the session **failed** (error): the implementation MUST preserve the
  registry entry and buffer (for debugging/inspection) and clean up only
  runtime state.

**Rationale:** Successful sessions have been fully consumed by all readers.
Failed sessions are retained so operators can inspect the error state.

### 7.3 `retain_forever`

Applied when `refCount` reaches zero and the writer task is done.

- The implementation MUST clean up runtime state (task handles, mutable
  status maps).
- The implementation MUST NOT delete the registry entry or buffer.
- The buffer and its data persist indefinitely until explicitly deleted by
  an external mechanism (admin API, manual cleanup).

### 7.4 `retain_until_ttl`

Applied when `refCount` reaches zero and the writer task is done.

- The implementation MUST clean up runtime state.
- The implementation MUST cancel any previously scheduled TTL task for this
  session.
- The implementation MUST schedule a background task that:
  1. Sleeps for `ttlMs` milliseconds.
  2. Re-checks `refCount` (a client may have reconnected during the TTL
     window).
  3. If `refCount` is still zero, deletes both the registry entry and
     buffer.
  4. If `refCount` is non-zero, takes no action.
- If `ttlMs` is zero or negative, the implementation MUST delete
  immediately (equivalent to `auto_delete_on_close` for successful
  sessions).

### 7.5 Cleanup Taxonomy

Retention involves two categories of state:

| Category | Contents | When Cleaned |
|---|---|---|
| **Runtime state** | Mutable status maps, writer task handles, retention task handles | Always cleaned when `refCount` hits zero (regardless of policy) |
| **Durable state** | Registry entry (`SessionEntry`) and buffer (token array) | Depends on policy and session outcome |

## 8. Storage Backend Conformance

### 8.1 Required Interfaces

A conforming storage backend MUST implement:

1. `TokenBufferStore<T>` — buffer creation, lookup, and deletion.
2. `SessionRegistryStore` — entry metadata with atomic ref-count updates.

A backend MAY implement only `TokenBufferStore<T>` if it delegates registry
management to a separate store (e.g., Redis buffers with in-memory registry).

### 8.2 Concurrency Requirements

| Operation | Requirement |
|---|---|
| `buffer.append()` | MUST be safe to call from a single writer. Concurrent writers are NOT required. |
| `buffer.read()` | MUST be safe to call concurrently from multiple readers. |
| `buffer.waitForChange()` | MUST be safe to call from multiple concurrent waiters. |
| `registryStore.updateRefCount()` | MUST be atomic. |
| `bufferStore.create()` + `registryStore.set()` | SHOULD be performed in sequence. Atomicity across both stores is NOT required (the `SessionRegistry` handles consistency). |

### 8.3 Durability Tiers

Backends are classified into durability tiers:

| Tier | Scope | Survives | Examples |
|---|---|---|---|
| **Ephemeral** | Single Effection scope | Nothing | In-memory store (`createInMemoryBufferStore`) |
| **Process-durable** | Single OS process | Request boundaries, scope destruction | Shared-memory store (`createSharedBufferStore`) |
| **Infrastructure-durable** | Cluster | Process restarts, deployments | Redis store (`createRedisTokenBufferStore`) |

- Development and test environments MAY use ephemeral storage.
- Single-server production deployments MUST use at least process-durable
  storage.
- Multi-server deployments MUST use infrastructure-durable storage.

### 8.4 Reference Implementation: In-Memory

The in-memory backend (`createInMemoryBufferStore`, `createInMemoryRegistryStore`)
is the reference implementation for the storage contract.

- Buffers are backed by plain JavaScript arrays.
- Change notification uses Effection `Signal` (scope-bound).
- Registry entries are stored in a `Map<string, SessionEntry>`.
- Suitable for tests and single-scope usage.
- NOT suitable for production (data lost on scope exit).

### 8.5 Reference Implementation: Shared-Memory

The shared-memory backend (`createSharedBufferStore`, `createSharedRegistryStore`)
is the recommended backend for single-server production.

- Backing storage (`SharedStorage<T>`) is created **outside** Effection
  scopes, at server startup.
- Buffers use `EventEmitter` for cross-scope change notification, with
  `sleep(1)` polling as a fallback for environments where `EventEmitter`
  interacts poorly with Effection's async context (e.g., Vite dev mode).
- Multiple store instances created from the same `SharedStorage` see the
  same data.
- State survives individual request scope destruction.

### 8.6 Reference Implementation: Redis

The Redis backend (`createRedisTokenBufferStore`) provides
infrastructure-durable storage.

- Tokens are stored in Redis Streams (`XADD`/`XRANGE`/`XDEL`).
- Metadata (completion status, error, ref count, flush watermark) is stored
  in Redis Hashes (`HSET`/`HGET`).
- Key schema: `{keyPrefix}{id}:stream` for tokens, `{keyPrefix}{id}:meta`
  for metadata. Default prefix is `durable-stream:`.
- The Redis store creates a sentinel entry on stream creation (then deletes
  it) to ensure the stream key exists in Redis before any reads.
- Change notification uses in-process `Signal` maps. This means
  `waitForChange` only detects local writes. For multi-process deployments,
  the transport layer's long-poll mechanism (polling with timeout) handles
  cross-process notification.
- The Redis store implements only `TokenBufferStore<T>`. It does NOT
  implement `SessionRegistryStore`. Deployments using Redis buffers SHOULD
  pair them with either an in-memory or Redis-backed registry store.
- Supports optional `flushOnRead` mode that records a high-water mark in
  metadata, enabling future garbage collection of consumed tokens.

#### 8.6.1 Redis Key Layout

| Key Pattern | Redis Type | Contents |
|---|---|---|
| `{prefix}{id}:stream` | Stream | Token entries, each with a `token` field containing JSON-serialized data |
| `{prefix}{id}:meta` | Hash | Fields: `id`, `createdAt`, `completed`, `error`, `refCount`, `flushedUpTo` |

#### 8.6.2 Redis-Specific Considerations

- `append()` uses `XADD` with auto-generated IDs (`*`). Token count is
  derived from `XRANGE` length minus one (accounting for the deleted
  sentinel entry).
- `read()` uses `XRANGE('-', '+')` to fetch all entries, filters out the
  `__init__` sentinel, and slices from `afterLSN`. This is an O(N) scan;
  large buffers SHOULD use `flushOnRead` to bound growth.
- `fail()` sets both `completed: 'true'` and `error: <message>` in the
  metadata hash. Recovery of error details is limited to the message string.

## 9. Producer/Consumer Patterns

### 9.1 Writing: `writeFromStreamToBuffer`

The canonical producer function bridges an Effection `Stream<T, void>` to a
`TokenBuffer<T>`:

```typescript
function* writeFromStreamToBuffer<T>(
  source: Stream<T, void>,
  buffer: TokenBuffer<T>
): Operation<void>
```

- Subscribes to the source stream and iterates tokens one at a time.
- Calls `buffer.append([token])` for each token.
- Calls `buffer.complete()` when the source stream ends.
- If the source stream throws, the error propagates to the caller (the
  `SessionRegistry` writer task catches it and calls `buffer.fail()`).

### 9.2 Reading: `createPullStream`

The canonical consumer creates a pull-based `Stream<TokenFrame<T>, void>`
from a buffer:

```typescript
function createPullStream<T>(
  buffer: TokenBuffer<T>,
  startLSN?: number
): Stream<TokenFrame<T>, void>

interface TokenFrame<T> {
  token: T
  lsn: number
}
```

- Maintains an internal cursor initialized to `startLSN` (default `0`).
- On each `next()` call:
  1. Reads from the buffer at the current cursor.
  2. If tokens are available, returns the first token with `lsn = cursor + 1`,
     advances the cursor.
  3. If no tokens are available and the buffer is failed, throws the error.
  4. If no tokens are available and the buffer is complete, returns
     `{ done: true }`.
  5. Otherwise, calls `waitForChange(cursor)` and retries.
- LSN values are 1-indexed and strictly sequential: 1, 2, 3, ...
- Emits one token per `next()` call (not batched).

### 9.3 Transport Integration

The transport layer consumes `createPullStream` and wraps each
`TokenFrame<T>` in a `DurableFrame` for the wire:

```
TokenBuffer → createPullStream → TokenFrame<string> → DurableFrame { lsn, event }
```

Where `event` is the deserialized `StreamEvent` (the token is a JSON string
in the chat protocol).

## 10. Conversation Index

Sessions are grouped into conversations via a conversation index. The index
maps a `conversationId` to an ordered list of `sessionId` values.

### 10.1 Storage

The conversation index is stored in the same `TokenBufferStore` used for
session buffers, using a reserved key prefix: `__conversation_index__:{conversationId}`.

- Each entry in the index buffer is a `sessionId` string.
- Appending a new session to a conversation appends its `sessionId` to the
  index buffer.
- Reading the conversation index returns the ordered list of session IDs.

### 10.2 Resolution

When a client requests history for a conversation:

1. The server reads the conversation index to get the list of session IDs.
2. For each session ID (in order), the server reads the corresponding buffer.
3. Frames from all sessions are concatenated in order to produce the full
   conversation history.
4. The latest (most recent) session is the "active" session for live
   streaming.

## 11. Security Considerations

### 11.1 Buffer Isolation

Implementations MUST ensure that a client cannot read or write to a buffer
it does not own. The mapping from client-facing identifiers (conversation ID,
session ID) to internal buffer IDs MUST be controlled by the server.

### 11.2 Resource Exhaustion

- Implementations SHOULD enforce maximum buffer sizes (token count or byte
  size) to prevent unbounded memory growth.
- Implementations SHOULD enforce maximum session counts per conversation.
- The `retain_until_ttl` policy SHOULD be preferred over `retain_forever`
  in production to prevent unbounded storage growth.

### 11.3 Ref-Count Integrity

- `updateRefCount` MUST be atomic to prevent ref-count drift under
  concurrent acquire/release.
- Implementations SHOULD detect and log negative ref counts as a bug
  indicator.
- The cleanup waiter pattern (Section 6.3, Case B) re-checks ref count
  after the writer completes, providing a safety net against race
  conditions between release and reconnect.

## 12. Conformance

A storage backend is conformant if:

1. It implements `TokenBufferStore<T>` and `SessionRegistryStore` per
   Sections 3–5.
2. All `TokenBuffer<T>` instances satisfy the behavioral contract in
   Section 3.2.
3. `updateRefCount` is atomic (Section 5.2.4).
4. The backend passes the reference test suite
   (`session-registry.test.ts`, `in-memory-store.test.ts`).

A `SessionRegistry<T>` implementation is conformant if:

1. It satisfies the acquire/release contract in Section 6.
2. It correctly applies all three retention policies (Section 7).
3. Writer tasks survive client disconnects (background task requirement).
4. The cleanup waiter re-checks ref count before applying retention.

---

[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[proto-lsn]: ./durable-stream-protocol.md#31-durable-frame
