# ADR: Turn-Scoped Durable Chat Sessions

## Status

**Accepted** - June 2026

## Context

The repository previously contained `@sweatpants/durable-conversations`, a spike package that explored a "one durable stream per conversation" model:

```txt
PUT  /conversations/{id}
POST /conversations/{id}
GET  /conversations/{id}?offset=X
```

That spike made replay easy to reason about: a conversation had one append-only event log, and a client could read frames from an offset to reconstruct state. It also tested useful behaviors such as continuing server-side work after a streaming reader disconnects.

However, the active framework durable chat path and the `specs/durable-stream-protocol.md` terminology use a different model:

- a **Conversation** is a multi-turn logical thread;
- a **Turn** is one user request and resulting assistant/tool activity;
- a **Session** is one durable stream for one turn;
- each session owns its own append-only event log and LSN sequence.

Keeping both models in the active workspace created competing bounded contexts and ambiguous language. The spike also mixed responsibilities: HTTP handler, store, NDJSON framing, React hook, demo component, echo tool policy, model-provider integration, Redis, and UI concerns were all exported from one public package.

## Decision

The canonical durable chat model is **turn-scoped durable sessions within multi-turn conversations**.

`@sweatpants/durable-conversations` is retired and removed from the active workspace. Its lessons are archived in `docs/archive/durable-conversations-spike-retirement.md`.

The future durable chat surface should be built from:

- `@sweatpants/framework` durable chat handler/session machinery;
- `@sweatpants/durable-streams` transport, buffer, frame, offset, and replay primitives;
- framework/AG-UI event catalog entries and checkpoints;
- React/client projections over canonical stream events.

## Rationale

### Turn-scoped sessions match request/response lifecycle

Each chat turn has a natural streaming lifetime: one POST request, one assistant/tool run, one append-only event log, and one completion/abort outcome. Scoping durable stream sessions to turns keeps LSNs, replay, completion, and error semantics local and easier to reason about.

### Conversations remain durable through projection

A conversation can still be reconstructed across turns by replaying canonical durable stream events/checkpoints and projecting them into client state. Conversation durability does not require a single transport stream per conversation.

### The model avoids a second public protocol

A conversation-scoped stream would require separate APIs, offsets, event vocabulary, tests, and documentation. The existing durable stream protocol already defines frames, LSNs, offsets, transport modes, replay, setup errors, and headers. Reusing that model avoids duplicated protocol surface.

### The spike crossed too many boundaries

The retired package bundled durable infrastructure with UI, demo tools, concrete model-provider policy, Redis integration, and example components. The canonical path should keep durable infrastructure separate from app/demo/provider concerns.

## Consequences

### Positive

- One durable chat vocabulary: Conversation, Turn, Session, Frame, LSN, Offset, Checkpoint.
- One protocol/spec path for durable stream behavior.
- One active implementation path for reconnects, replay, tool calls, elicitation, and checkpoints.
- Less package/API ambiguity for users and contributors.

### Negative / Tradeoffs

- Conversation-level full-history replay is not a single `GET /conversations/{id}?offset=X` primitive.
- Client or server projections must stitch conversation state across one or more turn-scoped sessions.
- Tests that were easy to describe in the spike must be ported to the canonical durable handler path.

## Follow-up Work

The useful spike scenarios should be preserved as deterministic tests or docs in the canonical path:

1. accepted server work survives streaming reader disconnect;
2. replay by offset after disconnect returns all persisted frames;
3. per-conversation mutating turns have defined ordering or conflict semantics;
4. elicit pause/resume flows survive reconnect;
5. client conversation state can be projected from canonical stream events/checkpoints.

## Alternatives Considered

### Keep `@sweatpants/durable-conversations` as a public package

Rejected. It made an experimental protocol look canonical and bundled too many unrelated responsibilities behind one export.

### Make one-stream-per-conversation the canonical model

Rejected. It conflicts with the current durable stream protocol, broadens the transport lifecycle beyond a single request/response turn, and would require a second event vocabulary and replay API.

### Keep the package but mark it private/internal

Rejected. Even as private code, the package would continue to create architectural ambiguity and maintenance drag. The lessons are better preserved in archive documentation and canonical tests.

## References

- `docs/archive/durable-conversations-spike-retirement.md`
- `specs/durable-stream-protocol.md`
- `specs/stream-event-catalog.md`
- `packages/framework/src/handler/durable/`
- `packages/durable-streams/`
