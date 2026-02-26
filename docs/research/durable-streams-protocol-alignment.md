# Durable Streams Protocol Alignment

Research and planning document for aligning sweatpants durable streams implementation with the [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md).

**Date**: 2026-02-26  
**Status**: Research Complete, Implementation Pending

---

## Executive Summary

The Durable Streams Protocol is an HTTP-based protocol for creating, appending to, and reading from durable, append-only byte streams. Our current implementation shares many core concepts but differs in wire protocol details. This document outlines alignment strategy while preserving our architectural advantages (Effection, pull-based streaming, session lifecycle management).

**Decision**: Implement protocol-compliant wire format ourselves (hybrid approach) rather than pulling in `@durable-streams/*` as dependencies. This preserves Effection integration and our richer session management while achieving wire-level interoperability.

---

## Table of Contents

1. [Protocol Overview](#protocol-overview)
2. [Current Implementation Analysis](#current-implementation-analysis)
3. [Gap Analysis](#gap-analysis)
4. [Architecture Decisions](#architecture-decisions)
5. [Implementation Plan](#implementation-plan)
6. [References](#references)

---

## Protocol Overview

### Core Concepts

The Durable Streams Protocol provides:

1. **Append-only streams** - Immutable by position, new data only appends
2. **Offset-based resumption** - Opaque, lexicographically sortable tokens
3. **Stream closure (EOF)** - Explicit, durable, monotonic end signal
4. **Multiple read modes** - Catch-up, Long-poll, SSE
5. **Idempotent producers** - Kafka-style exactly-once write semantics
6. **HTTP-native** - Designed for CDN caching and edge delivery

### Key Operations

| Operation | Method | Description |
|-----------|--------|-------------|
| Create | `PUT {stream-url}` | Create new stream |
| Append | `POST {stream-url}` | Add bytes to stream |
| Close | `POST {stream-url}` + `Stream-Closed: true` | Signal EOF |
| Read (catch-up) | `GET {stream-url}?offset=X` | Read from offset |
| Read (long-poll) | `GET {stream-url}?offset=X&live=long-poll` | Wait for new data |
| Read (SSE) | `GET {stream-url}?offset=X&live=sse` | Server-Sent Events stream |
| Metadata | `HEAD {stream-url}` | Get stream info without data |
| Delete | `DELETE {stream-url}` | Remove stream |

### Protocol Headers

**Request Headers:**
- `Content-Type` - Stream content type
- `Stream-TTL` / `Stream-Expires-At` - Expiry configuration
- `Stream-Closed: true` - Close stream with request
- `Stream-Seq` - Monotonic sequence for ordering
- `Producer-Id`, `Producer-Epoch`, `Producer-Seq` - Idempotent producer tuple

**Response Headers:**
- `Stream-Next-Offset` - Next offset to read from (opaque string)
- `Stream-Closed: true` - Stream is closed (EOF)
- `Stream-Up-To-Date: true` - Client has caught up to tail
- `Stream-Cursor` - For CDN collapsing in live modes
- `ETag` - For cache validation

### Durable Sessions Pattern

The [Durable Sessions](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai) blog post describes a higher-level pattern built on Durable Streams:

- **Multiplexed data** - Token streams, messages, presence, agent registration over single stream
- **Sync-based architecture** - Replaces request/response with persistent, subscribable sessions
- **Multi-user, multi-agent** - Users join mid-session, agents subscribe and respond
- **TanStack DB integration** - Reactive collections, optimistic mutations

---

## Current Implementation Analysis

### File Structure

```
packages/framework/src/
├── lib/chat/durable-streams/
│   ├── types.ts              # Core interfaces
│   ├── in-memory-store.ts    # In-memory TokenBuffer
│   ├── shared-memory-store.ts # Cross-scope persistence
│   ├── pull-stream.ts        # Pull-based reader
│   ├── session-registry.ts   # Lifecycle management
│   ├── web-stream-bridge.ts  # Effection → Web streams
│   ├── contexts.ts           # DI contexts
│   ├── use.ts                # Accessor hooks
│   └── setup.ts              # Setup helpers
└── handler/durable/
    ├── handler.ts            # createDurableChatHandler
    ├── chat-engine.ts        # State machine
    └── types.ts              # Handler types
```

### Core Abstractions

**TokenBuffer<T>** - Append-only log:
```typescript
interface TokenBuffer<T> {
  readonly id: string
  
  // Write side
  append(tokens: T[]): Operation<number>  // Returns LSN
  complete(): Operation<void>
  fail(error: Error): Operation<void>
  
  // Read side
  read(afterLSN?: number): Operation<{ tokens: T[]; lsn: number }>
  isComplete(): Operation<boolean>
  getError(): Operation<Error | null>
  waitForChange(afterLSN: number): Operation<void>
}
```

**SessionRegistry<T>** - Lifecycle management:
```typescript
interface SessionRegistry<T> {
  acquire(sessionId: string, options?: CreateSessionOptions<T>): Operation<SessionHandle<T>>
  release(sessionId: string): Operation<void>
}
```

**PullStream** - Per-client cursor:
```typescript
interface TokenFrame<T> {
  token: T
  lsn: number  // Log Sequence Number
}

function createPullStream<T>(buffer: TokenBuffer<T>, startLSN?: number): Stream<TokenFrame<T>, void>
```

### Current Wire Protocol

**Request:**
```
GET /chat/durable
Headers:
  X-Session-Id: {sessionId}      (optional, for reconnect)
  X-Last-LSN: {lsn}              (optional, resume point)
```

**Response:**
```
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
X-Session-Id: {sessionId}
Cache-Control: no-cache

{"lsn": 1, "event": {"type": "text", "content": "Hello"}}
{"lsn": 2, "event": {"type": "text", "content": " world"}}
{"lsn": 3, "event": {"type": "complete", "text": "Hello world"}}
```

### Architectural Strengths

1. **Effection-based** - Structured concurrency, automatic cleanup
2. **Pull-based streaming** - Natural backpressure, client controls pace
3. **Reference-counted sessions** - Clean lifecycle management
4. **Pluggable storage** - `TokenBufferStore` interface for backends
5. **Background writer survival** - LLM task survives client disconnect

---

## Gap Analysis

### Protocol Compliance

| Feature | Protocol Spec | Our Implementation | Status |
|---------|---------------|-------------------|--------|
| Append-only log | Required | `TokenBuffer.append()` | ✅ Aligned |
| Offset-based resumption | Opaque string offsets | Integer LSN | ⚠️ Needs mapping |
| Stream closure (EOF) | `Stream-Closed` header | `buffer.complete()` | ⚠️ Header missing |
| Catch-up mode | `GET ?offset=X` | `GET` + `X-Last-LSN` | ⚠️ Different params |
| Long-poll mode | `GET ?live=long-poll` | Not implemented | ❌ Missing |
| SSE mode | `GET ?live=sse` | Not implemented | ❌ Missing |
| Idempotent producers | `Producer-Id/Epoch/Seq` | Single-writer model | ✅ Not needed (see below) |
| Content-type awareness | JSON mode with boundaries | Implicit JSON events | ⚠️ Less flexible |
| Caching headers | Complex ETag strategy | `no-cache` only | ⚠️ Needs enhancement |
| URL-based addressing | `/streams/{id}?offset=X` | Query/header params | ⚠️ Different pattern |

### Idempotent Producers - Why We Don't Need Them

The protocol's idempotent producer mechanism solves **network retry safety** for external writers:

```
Client --POST body--> [network blip] --POST body--> Server
                      (duplicate risk)
```

Our architecture is different:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SINGLE WRITER                              │
│  LLM Provider ──► ChatEngine ──► TokenBuffer.append()           │
│                    (one task)     (sequential, in-process)      │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight**: The ChatEngine is the single writer to the buffer. There's no network boundary between producer and buffer - it's in-process. Even with parallel tool execution or sub-agents, events are serialized through the engine.

**User message dedup**: Handled at HTTP handler level with message IDs, not at buffer level.

### Our Unique Capabilities to Preserve

1. **Per-client rendering** - Transform tokens on read based on client preferences:
   ```
   TokenBuffer (raw tokens)
       ├──► PullStream(format="markdown") ──► Pre-render
       ├──► PullStream(format="html") ──► Pre-render
       └──► PullStream(format="raw") ──► Pass through
   ```

2. **Session lifecycle** - RefCount, abort, timeout, status tracking

3. **Effection integration** - Structured concurrency, contexts, cleanup

---

## Architecture Decisions

### Decision 1: Hybrid Approach

**Don't** pull in `@durable-streams/*` packages as dependencies because:
- Not built on Effection
- Would require wrapping/bridging their primitives
- Our `SessionRegistry` lifecycle is richer
- Dependency on external release cycle

**Do** implement protocol-compliant wire format ourselves:
- Same headers, query params, response formats
- Interoperable with their tooling/clients
- Future option to use their CDN/edge infrastructure

### Decision 2: Support Both Wire Formats

Implement both NDJSON and SSE:

| Format | Use Case | Implementation |
|--------|----------|----------------|
| NDJSON | Default, simpler client code | Current + protocol headers |
| SSE | Browser EventSource, auto-reconnect | New implementation |

Both share the same pull-based buffer reads - only serialization differs.

### Decision 3: URL-Based Stream Addressing

Migrate from header-based to URL-based:

**Before:**
```
GET /chat/durable
X-Session-Id: abc123
X-Last-LSN: 42
```

**After:**
```
GET /chat/sessions/abc123?offset=42
```

Benefits:
- RESTful semantics
- CDN cache keying on URL path
- Direct bookmarking/sharing
- Protocol compliance

### Decision 4: Offset Format

Keep integer LSN internally, expose as string externally:

```typescript
// Internal
const lsn: number = 42

// Wire format
const offset: string = String(lsn)  // "42"

// Or with namespace for future flexibility
const offset: string = `lsn:${lsn}` // "lsn:42"
```

Simple string representation maintains lexicographic ordering for integers.

### Decision 5: Storage Backend Priority

1. **In-memory** (done) - Development and testing
2. **Redis** - Pub/sub for `waitForChange`, natural fit
3. **Postgres** - LISTEN/NOTIFY for `waitForChange`, integrates with Electric

---

## Implementation Plan

### Phase 1: Protocol Headers & URL Routing

**Goal**: Wire protocol compliance for catch-up reads

**Tasks**:
1. Add URL-based routing: `/sessions/{sessionId}`
2. Implement protocol response headers:
   - `Stream-Next-Offset` (replaces inline LSN)
   - `Stream-Closed` (EOF signal)
   - `Stream-Up-To-Date` (caught up indicator)
3. Support `?offset=X` query parameter
4. Add `HEAD` endpoint for metadata
5. Implement ETag generation and `If-None-Match` handling

**Files to modify**:
- `handler/durable/handler.ts`
- New: `handler/durable/protocol-headers.ts`

### Phase 2: Long-Poll Mode

**Goal**: `?live=long-poll` support

**Tasks**:
1. Detect `live=long-poll` query parameter
2. Implement timeout-based waiting in handler
3. Return `204 No Content` on timeout (no new data)
4. Return `200 OK` with data when available
5. Add `Stream-Cursor` header for CDN collapsing

**Files to modify**:
- `handler/durable/handler.ts`
- `lib/chat/durable-streams/pull-stream.ts` (timeout support)

### Phase 3: SSE Mode

**Goal**: `?live=sse` support

**Tasks**:
1. Detect `live=sse` query parameter
2. Implement SSE response formatter:
   ```
   event: data
   data: {"type": "text", "content": "Hello"}
   
   event: control
   data: {"streamNextOffset": "43", "streamCursor": "abc"}
   ```
3. Add `Stream-Cursor` in control events
4. Handle connection lifecycle (~60s reconnect cycle)
5. Emit `streamClosed: true` on EOF

**Files to create**:
- `handler/durable/sse-formatter.ts`

### Phase 4: Storage Backends

**Goal**: Production-ready persistence

**Redis Backend**:
- Store tokens in Redis Stream or List
- Use pub/sub for `waitForChange` notifications
- TTL-based expiry

**Postgres Backend**:
- Store tokens in table with session_id, lsn, data
- Use LISTEN/NOTIFY for `waitForChange`
- Integrate with Electric for sync

**Files to create**:
- `lib/chat/durable-streams/redis-store.ts`
- `lib/chat/durable-streams/postgres-store.ts`

### Phase 5: Advanced Features (Future)

- `Stream-Cursor` CDN collapsing optimization
- `Content-Type: application/json` mode with message boundary preservation
- Retention policies and offset garbage collection
- Multi-server coordination

---

## References

### Protocol Documentation

- [Durable Streams Protocol Spec](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [Durable Sessions Blog Post](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai)
- [Durable Streams Announcement](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams)

### Our Documentation

- [Durable Streams Design](../durable-streams-design.md)
- [Durable Chat Handler Plan](../durable-chat-handler-plan.md)
- [Architecture Overview](../architecture.md)

### Related Projects

- [electric-sql/transport](https://github.com/electric-sql/transport) - Reference implementations
- [TanStack DB](https://tanstack.com/db) - Reactive client store
- [TanStack AI](https://tanstack.com/ai) - AI SDK with durable transport support

---

## Appendix: Protocol Header Reference

### Request Headers

| Header | Description | Example |
|--------|-------------|---------|
| `Content-Type` | Stream content type | `application/json` |
| `Stream-TTL` | Relative expiry (seconds) | `3600` |
| `Stream-Expires-At` | Absolute expiry (RFC 3339) | `2026-02-27T00:00:00Z` |
| `Stream-Closed` | Close stream with request | `true` |
| `Stream-Seq` | Monotonic sequence number | `5` |
| `Producer-Id` | Idempotent producer ID | `agent-1` |
| `Producer-Epoch` | Producer session epoch | `0` |
| `Producer-Seq` | Per-epoch sequence | `3` |

### Response Headers

| Header | Description | Example |
|--------|-------------|---------|
| `Stream-Next-Offset` | Next read position | `lsn:43` |
| `Stream-Closed` | Stream is closed (EOF) | `true` |
| `Stream-Up-To-Date` | Client caught up to tail | `true` |
| `Stream-Cursor` | CDN collapsing key | `abc123` |
| `ETag` | Cache validation | `"sess:0:43"` |
| `Cache-Control` | Caching directive | `public, max-age=60` |

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `offset` | Start position (or `-1` for beginning, `now` for tail) | `lsn:42` |
| `live` | Live mode | `long-poll` or `sse` |
| `cursor` | Echo of Stream-Cursor for CDN | `abc123` |

### SSE Event Format

```
event: data
data: [{"type": "text", "content": "Hello"}]

event: control
data: {"streamNextOffset": "lsn:43", "streamCursor": "xyz", "upToDate": true}

event: control
data: {"streamNextOffset": "lsn:50", "streamClosed": true}
```
