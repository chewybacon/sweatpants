# Durable Conversations Spike Retirement

## Status

Retired and removed from the active workspace.

## Decision

`@sweatpants/durable-conversations` was a spike, not the future public API. The canonical durable chat path is the framework durable handler plus `@sweatpants/durable-streams`, with:

- `conversationId` as the multi-turn thread identity;
- `sessionId` as the durable stream identity for one request/response turn;
- replay/resume handled through durable stream frames, offsets, checkpoints, and the framework event catalog.

The spike's "one durable stream per conversation" model is intentionally retired to avoid competing with the turn-scoped durable stream protocol.

## What We Learned

### Conversation replay is valuable

The spike demonstrated a useful product behavior: conversation state should be reconstructible from durable events after disconnects or reloads. That learning remains valid, but it should be implemented as a projection over the canonical framework/durable-stream event model rather than a second custom `ConversationEvent` protocol.

### Producer lifetime must be distinct from reader lifetime

One of the most important spike scenarios was:

1. a `POST` accepts work for a conversation;
2. the streaming reader disconnects;
3. server-side production continues;
4. a later read can replay the persisted frames.

The canonical durable handler should preserve this invariant: client stream cancellation must not cancel already-accepted server-side turn production unless an explicit abort/cancel operation is sent.

### Per-conversation mutation ordering matters

The spike serialized work per conversation with a small per-conversation runtime queue. That highlighted a real domain concern: concurrent mutating turns for the same conversation need defined semantics. The canonical path should either serialize them or document conflict behavior.

### Event-log plus reducer is the right shape, but not as a separate package

The spike's event log and reducer made replay easy to understand. The concept should live as documentation and tests for projecting canonical framework/AG-UI/durable-stream events into client conversation state, not as a standalone package with its own event vocabulary.

### Layer mixing was the warning sign

The spike bundled server handler, store, NDJSON framing, React hook, demo component, echo tool policy, concrete model-provider integration, Redis, and UI concerns behind one public package export. That was useful as a prototype, but it is the wrong long-term boundary.

Durable infrastructure should not own demo tools, concrete model-provider policy, React UI, or app-specific elicitation behavior.

### Live-provider tests are not durable protocol tests

The spike's tests depended on live Ollama/Redis availability and could return green without exercising the behavior. Durable protocol confidence should come from deterministic conformance tests, with live-provider flows treated only as optional smoke coverage.

## What Was Not Kept

The following spike-specific artifacts were intentionally not promoted:

- `PUT /conversations/{id}` as a public API;
- `GET /conversations/{id}?offset=X` as a separate conversation protocol;
- custom `ConversationEvent` / NDJSON framing;
- `useDurableConversation` and `DurableConversationExample`;
- the echo-tool demo path;
- concrete `model-provider-pi-ai` policy inside the durable primitive;
- Redis integration tests that silently pass when dependencies are unavailable.

## Follow-up Work for the Canonical Path

The useful scenarios should be covered, where not already covered, by deterministic tests against the framework durable handler and `@sweatpants/durable-streams`:

1. accepted server work survives streaming reader disconnect;
2. replay by offset after disconnect returns all persisted frames;
3. conversation-level mutating turns have defined ordering/conflict semantics;
4. elicit pause/resume flows are durable across reconnect;
5. conversation projection from canonical events is documented and tested.

## Vocabulary Going Forward

Use this terminology consistently:

- **Conversation**: a multi-turn logical thread.
- **Turn**: one user request and resulting assistant/tool activity.
- **Session**: one durable stream for one turn.
- **Frame**: a replayable durable event with an LSN/offset.
- **Checkpoint**: resumable state snapshot emitted within the canonical stream.

Avoid "one stream per conversation" except when referring to this retired spike.
