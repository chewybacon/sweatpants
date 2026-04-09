# Deterministic Message Identity Design

## Goal

Make message identity a first-class part of the chat transcript model so that:

- every `Message` has a stable, deterministic `id`
- assistant/tool/handoff phases can always be correlated back to their origin point
- replay, hydration, reducer deduplication, and rendered part storage all operate on the same transcript tree
- the durable stream records enough semantic structure that the client does not need to invent identity during replay

## Problem

Today the framework treats `Message.id` as optional and fills gaps with random UUIDs in multiple places.

This causes a few classes of bugs:

- replayed `history_message` patches can carry `parts`, but those parts are only persisted in `finalizedParts` when `message.id` exists
- the same logical message can receive different IDs depending on whether it was created during live execution, turn sync, or durable replay
- handoff turns split assistant text, tool calls, and tool results across `conversation_state`, `tool_result`, and `complete` events, but message identity is not preserved across those boundaries
- downstream code falls back to `crypto.randomUUID()` or `msg-${Date.now()}`, which papers over missing structure instead of preserving it

The bug we just hit in threaded durable replay is a concrete example: a replayed assistant tool-call message without an `id` could not retain its rendered tool-call part with emissions, so one completed handoff lost its interactive replay state after refresh.

## Design Principles

### Transcript Identity Is Structural

Message identity should come from transcript structure, not from whichever layer happened to materialize a `Message` object first.

The important structural facts are:

- user messages begin a turn from the client side
- assistant messages with `tool_calls` begin a tool subtree
- tool messages belong to a specific `tool_call_id`
- assistant completion messages close a turn after a specific assistant/tool subtree
- handoff and elicitation phases are not separate transcript roots; they are phases within the same assistant tool-call subtree

### Tool Call IDs Are Already Stable

`tool_calls[].id` and `tool_call_id` are already deterministic and provider-correlated. The design should reuse those IDs as the backbone of tool subtree identity.

### Replay Must Never Invent Identity

Replay should validate identity invariants, not manufacture them. If a durable `conversation_state` contains malformed messages, that is a writer bug.

## Proposed Identity Model

### Message ID Format

Introduce a deterministic string identity format for transcript messages:

- `user:<turnKey>`
- `assistant:tools:<toolCallIdList>`
- `tool:<toolCallId>`
- `assistant:final:<turnKey>`
- `system:<index>`

Where:

- `toolCallIdList` is the sorted, comma-joined list of tool call IDs on that assistant tool-call message
- `turnKey` is a stable per-turn identifier derived from the nearest structural anchor

### Turn Key Rules

We need a stable identifier for user/assistant-final pairs that is consistent across live execution and replay.

Use the following rules:

1. If a turn has tool calls, the turn key is the first tool call ID in lexical order.
2. If a turn has no tool calls, derive the turn key from the ordinal of the user message in transcript order:
   - `u1`, `u2`, `u3`, ... for root user turns
3. For system messages, use transcript ordinal:
   - `system:0`, `system:1`, ...

This gives us:

- first user message before tool call `call_abc` => `user:call_abc`
- assistant tool-call message for `call_abc` => `assistant:tools:call_abc`
- tool result for `call_abc` => `tool:call_abc`
- final assistant follow-up after that tool cycle => `assistant:final:call_abc`

For a no-tools turn:

- user => `user:u2`
- assistant final => `assistant:final:u2`

## Correlation Model

This identity scheme makes the transcript tree explicit:

- `user:<turnKey>` is the turn root
- `assistant:tools:<toolCallIds>` is the assistant branch that introduces tool work
- `tool:<toolCallId>` nodes are children of that assistant tools node
- `assistant:final:<turnKey>` is the completion node for that same turn

For multi-tool assistant messages:

- assistant node ID is `assistant:tools:call_a,call_b`
- tool children are `tool:call_a` and `tool:call_b`
- final assistant node is `assistant:final:call_a`

We anchor the final assistant to the first sorted tool call ID for determinism.

## Scope of Change

### 1. Make `Message.id` Required

Update `packages/framework/src/lib/chat/types.ts`:

- change `id?: string` to `id: string`

This intentionally pushes compile-time failures to all construction sites.

### 2. Introduce a Shared Message Identity Utility

Add a shared utility module, likely under:

- `packages/framework/src/lib/chat/message-identity.ts`

Proposed API:

```ts
export interface MessageIdentityContext {
  userTurnOrdinal?: number
}

export function messageIdForUser(turnKey: string): string
export function messageIdForAssistantTools(toolCallIds: string[]): string
export function messageIdForTool(toolCallId: string): string
export function messageIdForAssistantFinal(turnKey: string): string
export function messageIdForSystem(index: number): string
export function deriveTurnKeyFromToolCalls(toolCallIds: string[]): string
```

We may also want a transcript-aware helper:

```ts
export function assignDeterministicMessageIds(messages: Message[]): Message[]
```

This would be useful for validating incoming history or normalizing legacy data during migration.

### 3. Assign IDs at Construction Sites

All message construction sites in:

- `packages/framework/src/handler/durable/chat-engine.ts`
- `packages/framework/src/lib/chat/session/create-session.ts`
- `packages/framework/src/lib/chat/session/turn-manager.ts`

must use the shared deterministic helpers rather than `crypto.randomUUID()`.

### 4. Remove Replay-Side ID Invention

Remove replay-time ID generation from:

- `packages/framework/src/lib/chat/session/durable-history.ts`

Replace it with invariant checks. If we still need a migration path for legacy persisted transcripts, make that explicit and isolated.

## Writer Responsibilities

The writer side of the protocol must guarantee:

1. every message written into `conversationMessages` has an `id`
2. every `conversation_state.messages` entry has an `id`
3. assistant tool-call messages and tool result messages are correlated by stable IDs and `tool_call_id`
4. messages reconstructed from split protocol fields (`assistantContent`, `toolCalls`, `serverToolResults`) receive the same deterministic IDs they would have had if written monolithically

## Migration / Compatibility

We may already have durable transcripts with missing IDs.

Handle this in two phases:

### Phase 1

- implement deterministic IDs at all writer sites
- keep a narrow replay compatibility shim for legacy malformed transcripts
- log or surface when replay had to normalize a legacy message

### Phase 2

- remove the compatibility shim after confidence and migration window

The compatibility shim should live in a clearly-named function like `normalizeLegacyTranscriptMessageIds()` rather than inline fallback assignment.

## TDD Plan

### Unit Tests

Add tests for the new message identity utility:

- same tool call set always produces same assistant tools ID
- tool result IDs are deterministic from `tool_call_id`
- final assistant IDs derive from the same turn key as the tool subtree
- no-tools turns produce deterministic user/final IDs by transcript ordinal

### Session / Turn Tests

Add or update tests in:

- `packages/framework/src/lib/chat/session/__tests__/history-sync.test.ts`
- `packages/framework/src/lib/chat/session/__tests__/durable-history.test.ts`

to verify:

- assistant/tool messages created during handoff reconstruction have deterministic IDs
- `conversation_state` replay never needs to invent IDs for newly-written transcripts
- multi-turn handoff replay preserves both tool-call message IDs and tool result IDs across refresh

### Durable Handler Tests

Add black-box tests to:

- `packages/framework/src/handler/durable/__tests__/handler.test.ts`

to verify streamed `conversation_state.messages` entries always carry IDs, especially:

- assistant messages with `tool_calls`
- placeholder tool messages for phase 2 handoffs
- plugin awaiting-elicit assistant messages

### E2E

Keep the existing regression coverage in:

- `apps/yo-chat/e2e/threaded-chat.spec.ts`

This remains the final acceptance test.

## Implementation Steps

1. Add deterministic message identity utility and tests
2. Update `Message` type to require `id`
3. Update writer/construction sites to use deterministic IDs
4. Update turn-manager sync paths to preserve/validate deterministic IDs instead of inventing them
5. Narrow replay compatibility handling for legacy transcripts
6. Remove unconditional replay-side ID fallback
7. Run unit + handler + e2e tests

## Open Questions

### Should final assistant IDs use the first tool call ID or the full tool set?

Recommendation: use the first sorted tool call ID as the turn key.

Why:

- simpler and shorter IDs
- stable for the common single-tool case
- preserves linkage between user / assistant tools / final assistant messages within one turn

### Should user message IDs be content-derived?

Recommendation: no.

Content-derived IDs are brittle under edits and duplicate messages. Transcript position / turn structure is the better source of truth.

### Should we encode parent IDs explicitly?

Eventually maybe, but not required for this change. Once message IDs are deterministic, parent relationships can be derived from role + turn key + tool call IDs.

## Recommended Next Move

Implement this with TDD in three slices:

1. shared identity helper + unit tests
2. writer-side deterministic IDs in engine/session construction
3. replay invariant tightening + black-box/e2e verification
