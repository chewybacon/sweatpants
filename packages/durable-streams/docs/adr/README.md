# Architecture Decision Records

## ADR-001: TokenBuffer is Ephemeral, Durable Stream is Persistent

**Status:** Accepted

**Context:**
We needed to clarify the role of the TokenBuffer vs the Durable Stream storage. Initially the TokenBuffer was acting as both the ephemeral bridge and the persistent store, which conflated two distinct concerns.

**Decision:**
- **TokenBuffer** is ephemeral. It accumulates tokens from the LLM stream and flushes them to the durable store on read. It is ref-counted and destroyed when: (1) LLM stream is closed, (2) buffer is fully flushed, (3) ref count reaches 0, (4) tokens are committed to the durable stream.
- **Durable Stream** is persistent. It owns the LSN sequence and is the source of truth. All clients read from the same durable stream at their own offsets.

**Consequences:**
- TokenBuffer is no longer the source of truth; the durable stream is.
- Multiple clients can read from the same durable stream at different offsets without per-session complexity.
- Reconnect is trivial: client reads from durable stream at their last known offset.
- TokenBuffer lifecycle is bounded and predictable.

## ADR-002: Flush-on-Read TokenBuffer

**Status:** Accepted

**Context:**
We needed a mechanism to coalesce individual LLM tokens into batches before persisting to the durable stream, allowing clients to read at their own pace without processing every token delta.

**Decision:**
The TokenBuffer flushes its accumulated tokens to the durable stream when a client calls `read()`. The flush returns all accumulated tokens since the last flush (or since stream start). The buffer is emptied after flush.

**Consequences:**
- Fast readers get smaller batches; slow readers get larger batches.
- The durable store records coalesced batches, not individual tokens.
- Clients can control their effective read speed by how frequently they call `read()`.
- The TokenBuffer acts as a write optimizer, not a persistent cache.

## ADR-003: Redis Streams as Durable Store Backend

**Status:** Accepted

**Context:**
We needed a persistent backend for the durable stream that supports append-only semantics, offset-based reads, and blocking wait-for-change for live tailing.

**Decision:**
Use Redis Streams as the primary durable store backend:
- `XADD` for `append()` — stores batch entries with metadata
- `XRANGE` for `read()` — retrieves batches from a given offset
- `XREAD BLOCK` for `waitForChange()` — blocks until new data arrives
- `XLEN` for `nextOffset()` — returns current stream length

**Consequences:**
- Natural fit for append-only log semantics.
- Built-in blocking read eliminates polling.
- Multi-instance coordination via shared Redis.
- Requires Redis deployment (provided via Docker Compose for local dev).
- In-memory store remains available for dev/testing.

## ADR-004: In-Memory Default, Redis for Production

**Status:** Accepted

**Context:**
We needed to decide whether to default to Redis or keep in-memory as the default for development.

**Decision:**
- In-memory store remains the default for development and testing.
- Redis is opt-in via configuration and becomes the production default.
- Both stores implement the same `TokenBufferStore<T>` interface.

**Consequences:**
- Zero dependency for local development.
- Easy testing without Docker.
- Production deployments require Redis.
- Clear migration path from in-memory to Redis.

## ADR-005: Ref-Counted TokenBuffer Lifecycle

**Status:** Accepted

**Context:**
We needed a clear lifecycle for when the TokenBuffer should be destroyed to prevent memory leaks while ensuring all data is persisted.

**Decision:**
The TokenBuffer is ref-counted and destroyed when ALL conditions are met:
1. LLM stream is closed (no more tokens arriving)
2. Buffer is fully flushed (all tokens committed to durable stream)
3. Ref count reaches 0 (no active readers)
4. Tokens are committed (durable store acknowledges the write)

**Consequences:**
- Predictable memory management.
- No data loss: tokens are persisted before buffer destruction.
- Late readers can still read from the durable stream even after buffer is destroyed.
- Ref counting enables safe concurrent access.
