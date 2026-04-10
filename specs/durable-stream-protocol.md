# Durable Stream Protocol

- **Status:** Draft
- **Version:** 2026-04-10
- **Companion:** [Stream Event Catalog](./stream-event-catalog.md)

## 1. Introduction

The Durable Stream Protocol defines a framing layer, transport contract, and
session lifecycle for streaming LLM chat events over HTTP. It wraps
[AG-UI protocol][ag-ui] event types inside a durable framing envelope that
provides log sequence numbers, reconnection, and full-history replay.

### 1.1 Design Goals

1. **Durability.** Every event emitted during a chat turn is persisted in an
   append-only log. A client that disconnects mid-stream can reconnect and
   receive all events it missed.

2. **Replay.** A client that mounts a conversation for the first time (or
   refreshes the page) can replay the full event history and reconstruct UI
   state without a separate "load messages" API.

3. **Observability.** The protocol exposes a callback-based observation API
   that provides raw wire-level visibility into every event, in both live and
   replay paths, without coupling consumers to the transport layer.

4. **Simplicity.** The wire format is newline-delimited JSON (NDJSON). No
   binary encoding, no custom framing beyond JSON + newlines.

### 1.2 Relationship to AG-UI

The Durable Stream Protocol is **not** a replacement for the AG-UI protocol.
It is a transport and durability layer that carries AG-UI events as payload.
The `StreamEvent` union (Section 3.3) includes all standard AG-UI event types
plus framework-specific extensions. Framework extensions are explicitly
identified in the [Stream Event Catalog](./stream-event-catalog.md).

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119][rfc2119].

| Term | Definition |
|---|---|
| **Session** | A single streaming request/response pair. Each POST to the chat endpoint creates one session. A session owns exactly one append-only event log. |
| **Conversation** | A logical thread of chat turns. A conversation spans one or more sessions (one per turn). Identified by a `conversationId`. |
| **Frame** | A single unit on the wire: `{ "lsn": <number>, "event": <StreamEvent> }`. Also called a `DurableFrame`. |
| **LSN** | Log Sequence Number. A 1-indexed, monotonically increasing, gap-free integer assigned to each frame within a session. |
| **Buffer** | The server-side append-only log that stores serialized events for a session. |
| **Phase** | Whether an event is being observed during live streaming (`"live"`) or during history replay (`"replay"`). |
| **Turn** | A single request-response exchange within a conversation — one user message and the resulting assistant response. Each turn corresponds to one session. |
| **Offset** | A client-supplied LSN indicating "I have already consumed events up to this number; start from the next one." Sent as a query parameter. |

## 3. Wire Format

### 3.1 DurableFrame

Each line in an NDJSON response body is a **DurableFrame**.

```
{ "lsn": <number>, "event": <StreamEvent> }
```

A conforming producer:

- MUST emit exactly one JSON object per line.
- MUST terminate each line with a single `\n` (U+000A).
- MUST NOT emit blank lines between frames (consumers SHOULD tolerate them).
- MUST include both `lsn` and `event` fields on every frame.

A conforming consumer:

- MUST parse each line as an independent JSON object.
- MUST tolerate blank lines (skip them).
- MUST tolerate unknown fields on the frame object.

### 3.2 Log Sequence Number (LSN)

The `lsn` field is a positive integer that identifies a frame's position in
the session log.

| Requirement | Level |
|---|---|
| LSNs MUST be positive integers (>= 1). | MUST |
| LSNs MUST be 1-indexed (first event in a session has `lsn: 1`). | MUST |
| LSNs MUST be strictly monotonically increasing within a session. | MUST |
| LSNs MUST be gap-free (sequential: 1, 2, 3, ...). | MUST |
| LSNs MUST be assigned server-side. | MUST |
| Error events MUST maintain monotonicity (`lastLSN + 1`). | MUST |
| Setup errors (before any events are emitted) MUST use `lsn: 0`. | MUST |
| The replay path MUST preserve original LSN values. | MUST |

LSNs are scoped to a single session. Different sessions within the same
conversation have independent LSN sequences.

### 3.3 StreamEvent

The `event` field is a discriminated union on the `type` property. The full
catalog of event types, their fields, and their categories is defined in the
companion [Stream Event Catalog](./stream-event-catalog.md).

Events are organized into six categories:

| Category | Description | Provenance |
|---|---|---|
| **Lifecycle** | Run start/finish, session info | AG-UI + framework extension |
| **Text** | Text message streaming (start, content deltas, end), thinking | AG-UI + framework extension |
| **Tool** | Tool call lifecycle, results, errors, handoffs, elicitation | AG-UI + framework extension |
| **State** | Messages snapshot, state snapshot, checkpoint | AG-UI |
| **Error** | Error events | Framework extension |
| **Other** | Any event type not covered above | — |

A conforming consumer MUST tolerate unknown event types (forward compatibility).

## 4. Transport

### 4.1 Content Negotiation

| Content-Type | Activation | Description |
|---|---|---|
| `application/x-ndjson` | Default | Newline-delimited JSON DurableFrames |
| `text/event-stream` | `?live=sse` query param | Server-Sent Events encoding |
| `application/json` | `Accept: application/json` | JSON array snapshot (non-streaming) |

The server MUST support `application/x-ndjson`. Support for SSE and JSON
snapshot modes is OPTIONAL.

### 4.2 Live Streaming (POST)

A live streaming request initiates a new chat turn.

**Request:**

| Field | Value |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` |
| Body | JSON object with `messages`, tool schemas, `conversationId`, etc. |

**Response:**

| Field | Value |
|---|---|
| Status | `200 OK` |
| Content-Type | `application/x-ndjson` |
| Body | NDJSON stream of DurableFrames |

**Required response headers:**

| Header | Requirement | Description |
|---|---|---|
| `X-Session-Id` | MUST | The session ID for this streaming turn |
| `Cache-Control` | MUST | `no-store` |

**Recommended response headers:**

| Header | Requirement | Description |
|---|---|---|
| `X-Protocol-Version` | SHOULD | Date-based version string (e.g., `2026-04-10`) |
| `Stream-Next-Offset` | SHOULD | Zero-padded 16-digit LSN of the buffer tail |

The server MUST create a new session for each POST request. The server MUST
persist all emitted events to the session buffer before or atomically with
transmission to the client.

### 4.3 History Replay (GET)

A replay request retrieves the full event history for a conversation.

**Request:**

| Field | Value |
|---|---|
| Method | `GET` |
| Query | `?conversationId=<id>&offset=0` |
| Accept | `application/x-ndjson` |

**Response:**

| Status | Condition |
|---|---|
| `200 OK` | Conversation exists; body is the full NDJSON stream |
| `404 Not Found` | Conversation has no sessions |

The client MUST send an explicit `offset` parameter. The client MUST send
`offset=0` when requesting a full replay from the beginning.

The server MUST resolve the conversation to its latest surviving session. The
server MUST preserve original LSN values from the session log (no
renumbering). The server MUST return all frames from `offset + 1` through the
end of the log.

### 4.4 Reconnection (GET with offset > 0)

A reconnecting client resumes consumption from a known position.

**Request:**

| Field | Value |
|---|---|
| Method | `GET` |
| Query | `?sessionId=<id>&offset=<last-seen-lsn>` |

**Response:**

The server MUST return only frames with `lsn > offset`. All returned LSNs
MUST be greater than the supplied offset.

The server MUST support offset-based reconnection for any session whose buffer
has not been deleted by retention policy.

The client MAY use offset-based reconnection. A client that does not implement
reconnection MUST request full replay with `offset=0`.

**Special offset values:**

| Value | Meaning |
|---|---|
| `0` | Start from the beginning (full replay) |
| `-1` | Alias for `0` (backward compatibility) |
| `now` | Start from the current tail (receive only future events) |
| `<integer>` | Resume after the given LSN |

### 4.5 Long-Poll Mode

Activated via the `?live=long-poll` query parameter. This mode is OPTIONAL for
both servers and clients.

When the client is caught up to the buffer tail, the server MUST block until
one of:

1. New events are appended to the buffer.
2. The buffer is completed or failed.
3. A server-defined timeout elapses (SHOULD default to 30 seconds).

**Timeout response:**

| Field | Value |
|---|---|
| Status | `204 No Content` |
| `Stream-Up-To-Date` | `true` |

The client SHOULD re-poll on receiving a 204 with `Stream-Up-To-Date: true`.

**Stream closed response:**

| Field | Value |
|---|---|
| Status | `204 No Content` |
| `Stream-Closed` | `true` |

The client MUST stop polling on receiving `Stream-Closed: true`.

**Response headers for long-poll:**

| Header | Description |
|---|---|
| `Stream-Cursor` | Time-bucket cursor for poll continuation |
| `Stream-Next-Offset` | Next LSN to request |

### 4.6 Response Headers (Complete Reference)

| Header | Requirement | Format | Description |
|---|---|---|---|
| `X-Session-Id` | MUST | UUID string | Identifies the durable session |
| `Cache-Control` | MUST | `no-store` | Prevents proxy/browser caching |
| `Content-Type` | MUST | MIME type | Per content negotiation (Section 4.1) |
| `X-Protocol-Version` | SHOULD | Date string (`YYYY-MM-DD`) | Protocol version |
| `Stream-Next-Offset` | SHOULD | Zero-padded 16-digit integer | Buffer tail LSN |
| `Stream-Up-To-Date` | Conditional | `true` | Client has consumed all available events |
| `Stream-Closed` | Conditional | `true` | Stream is complete AND client is caught up |
| `ETag` | MAY | `"<sessionId>:<start>:<tail>:<c\|o>"` | Conditional GET support (`c` = closed, `o` = open) |
| `Stream-Cursor` | Long-poll only | Opaque string | Continuation cursor for polling |

## 5. Session Lifecycle

### 5.1 Session Identity

Each POST request creates exactly one session. The session ID:

- MUST be a UUID if not explicitly provided by the client.
- MUST be unique within the server's session namespace.
- MUST be returned in the `X-Session-Id` response header.

### 5.2 Conversation Index

A conversation is an ordered sequence of sessions (one per turn).

| Requirement | Level |
|---|---|
| The server MUST maintain a mapping from `conversationId` to an ordered list of `sessionId` values. | MUST |
| When resolving a conversation for replay, the server MUST return the latest surviving session. | MUST |
| A session is "surviving" if its buffer has not been deleted by retention policy. | — |
| The conversation index itself MUST NOT be subject to session retention policies. | SHOULD |

### 5.3 Buffer States

A session buffer transitions through the following states:

```
streaming ──► complete
    │
    ├──────► error
    │
    └──────► aborted
```

| State | Description |
|---|---|
| `streaming` | Actively receiving events from the producer. |
| `complete` | Producer finished gracefully. No more events will be appended. |
| `error` | Producer encountered a terminal error. The error MUST be retrievable. |
| `aborted` | Cancelled by client disconnect or server-side abort. |

A buffer in any terminal state (`complete`, `error`, `aborted`) MUST NOT
accept further appends.

### 5.4 Ref-Counting

Session buffers are reference-counted to manage concurrent readers.

| Requirement | Level |
|---|---|
| Each `acquire()` call MUST increment the ref-count. | MUST |
| Each `release()` call MUST decrement the ref-count. | MUST |
| Retention policy MUST NOT be applied while ref-count > 0. | MUST |
| When ref-count reaches 0 and the buffer is in a terminal state, the server MUST apply the configured retention policy. | MUST |

### 5.5 Retention Policies

| Policy | Behavior |
|---|---|
| `auto_delete_on_close` | Delete buffer when ref-count reaches 0 and buffer is complete. Preserve on error (for debugging). This is the default. |
| `retain_forever` | Never automatically delete. |
| `retain_until_ttl` | Delete after a configured TTL (in milliseconds) following buffer completion. |

The server MUST support at least the `auto_delete_on_close` policy. Support
for `retain_forever` and `retain_until_ttl` is RECOMMENDED.

## 6. Event Delivery Semantics

### 6.1 Ordering

Events MUST be delivered in LSN order. Within a session, event order is total
— there is no partial ordering or concurrent delivery of events.

A conforming producer MUST NOT emit events out of LSN order. A conforming
consumer MAY assert monotonicity and treat a violation as a protocol error.

### 6.2 Delivery Guarantees

The protocol provides **at-least-once** delivery semantics when reconnection
is used.

| Guarantee | Mechanism |
|---|---|
| No event loss | Events are persisted before delivery; replay provides the full log. |
| Idempotent resumption | Offset-based reconnection skips already-consumed events. |
| No LSN-based deduplication | The protocol does not deduplicate by LSN. Consumers that reconnect with the correct offset will not see duplicates. |

Content-level deduplication (e.g., by `tool_call_id` or message identity) is a
concern of higher-level consumers, not the protocol.

### 6.3 Backpressure

The protocol uses a **pull-based** delivery model.

| Requirement | Level |
|---|---|
| The server MUST NOT push events faster than the client reads them. | MUST |
| The server MUST buffer events that the client has not yet consumed. | MUST |
| Buffer size limits are a deployment concern, not a protocol concern. | — |

In NDJSON mode, the server writes to the HTTP response body; TCP flow control
provides natural backpressure. In long-poll mode, the client explicitly pulls
batches.

### 6.4 Error Handling

Errors MUST be communicated as in-band `StreamEvent` objects with
`type: "error"`.

| Requirement | Level |
|---|---|
| Runtime errors MUST be emitted as `{ type: "error", message: <string>, recoverable: <boolean> }`. | MUST |
| Error events MUST have `lsn = lastLSN + 1` to maintain monotonicity. | MUST |
| Setup errors (before any events are emitted) MUST use `lsn: 0`. | MUST |
| The server SHOULD set `recoverable: false` for terminal errors. | SHOULD |
| After emitting a non-recoverable error, the server MUST close the stream. | MUST |

## 7. Client Observation API

The observation API provides raw wire-level visibility into every event
flowing through the session, for both live and replay paths.

### 7.1 StreamEventEntry

An observation entry has the following shape:

```typescript
interface StreamEventEntry {
  /** Log sequence number from the durable frame. */
  lsn: number
  /** The raw stream event. */
  event: StreamEvent
  /** Whether the event was received live or replayed from history. */
  phase: 'live' | 'replay'
  /** Timestamp (Date.now()) when the event was observed client-side. */
  receivedAt: number
}
```

### 7.2 onStreamEvent Callback

The `onStreamEvent` callback is an OPTIONAL field on `SessionOptions`.

```typescript
interface SessionOptions {
  onStreamEvent?: (entry: StreamEventEntry) => void
}
```

| Requirement | Level |
|---|---|
| When provided, the callback MUST be invoked for every event in both the live streaming and history replay paths. | MUST |
| The callback MUST be invoked synchronously, before the event is processed into patches. | MUST |
| The implementation MUST NOT batch or defer callback invocations. | MUST |
| When the callback is `undefined`, the implementation MUST NOT incur observation overhead. | MUST |

### 7.3 Phase Semantics

| Phase | Source Path | Description |
|---|---|---|
| `replay` | History replay (GET path, `readDurableHistory`) | Events replayed from a persisted session log. |
| `live` | Live streaming (POST path, `mapStreamEventsToPatches`) | Events received in real-time from an active LLM turn. |

The `phase` field MUST accurately reflect the code path that produced the
observation. A replayed event MUST NOT be tagged as `live`, and vice versa.

### 7.4 Timing Semantics

The `receivedAt` field records the wall-clock time (`Date.now()`) at the
moment the event was observed by the client framework.

- For `live` events, `receivedAt` approximates the time the event arrived
  over the network.
- For `replay` events, `receivedAt` reflects the time of replay processing,
  NOT the original emission time.

The protocol does not currently carry server-side timestamps. Consumers MUST
NOT interpret `receivedAt` as the time the server emitted the event.

### 7.5 Consumer Contract

| Requirement | Level |
|---|---|
| Consumers MUST NOT throw exceptions from the `onStreamEvent` callback. | MUST |
| Consumers SHOULD NOT perform expensive or blocking work in the callback. | SHOULD |
| There is no backpressure mechanism from observer to producer. | — |
| Consumers MAY accumulate entries for deferred rendering (e.g., a devtools panel). | MAY |

## 8. Security Considerations

| Concern | Requirement |
|---|---|
| Session IDs are bearer tokens. Possession of a session ID grants read access to the event log. | The server SHOULD implement authentication and authorization at the transport layer (e.g., cookies, JWT). |
| Event payloads may contain sensitive data (user messages, tool results). | The server MUST set `Cache-Control: no-store` on all streaming responses to prevent proxy caching. |
| The protocol does not define encryption. | Deployments MUST use TLS (HTTPS) for transport security. |
| The observation API exposes raw events to client-side code. | Application developers SHOULD be aware that `onStreamEvent` callbacks have access to all event data, including tool call arguments and results. |

## 9. Future Extensions

The following areas are identified for future specification work:

- **Server-side timestamps.** Adding an `emittedAt` field to `DurableFrame`
  to enable latency measurement and timeline reconstruction.
- **Protocol version negotiation.** Client sends `X-Protocol-Version` in
  request headers; server responds with the version it will use.
- **Compression.** Gzip or zstd compression of NDJSON response bodies.
- **Selective replay.** Replaying only specific event categories or LSN
  ranges.
- **Cross-process change notification.** Redis pub/sub or similar mechanism
  for `waitForChange` across server instances.

## 10. References

- [RFC 2119 — Key words for use in RFCs][rfc2119]
- [NDJSON — Newline Delimited JSON][ndjson]
- [AG-UI Protocol][ag-ui]
- [Effection — Structured Concurrency for JavaScript][effection]

[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[ndjson]: https://github.com/ndjson/ndjson-spec
[ag-ui]: https://docs.ag-ui.com/
[effection]: https://frontside.com/effection
