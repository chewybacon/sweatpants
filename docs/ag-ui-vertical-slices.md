# AG-UI Vertical Slices

## Goal

Adopt AG-UI as the canonical wire protocol and durable serialization model for chat runs, while preserving the strengths of the current execution core:

- threaded conversations
- durable replay and refresh hydration
- tool execution
- interactive handoff / elicitation flows
- semantic UI replay for custom tool experiences

This document breaks the migration into de-risking spikes and vertical implementation slices that can be worked on concurrently.

## Why This Migration

Our current core execution model is strong, but the wire protocol and replay model have grown organically around custom events such as:

- `conversation_state`
- `isomorphic_handoff`
- `elicit_request`
- `tool_session_status`

AG-UI gives us a cleaner foundation for:

- explicit message identity
- tool lifecycle identity
- run/thread lineage
- serialization and compaction
- standardized snapshots and event streams

The hard part is not text/tool basics. The hard part is making pause/resume, handoff, and semantic tool replay fit cleanly.

## Core Assumption

We are willing to let the entire wire event and messaging format converge toward AG-UI, not just expose AG-UI as a compatibility wrapper.

That means:

- current `StreamEvent` is transitional
- current custom serialization format is transitional
- durable replay should eventually be AG-UI-native

## De-Risk First

Before broad implementation, we should finalize the unknowns that might force architectural adaptation.

### Spike A — Checkpoint Model

#### Goal

Figure out what replaces current `conversation_state`.

#### Questions

- Is AG-UI `MessagesSnapshot` + `StateSnapshot` sufficient?
- Do we need a custom checkpoint event to capture pending tool/handoff state?
- What must be persisted to guarantee refresh hydration across paused and completed runs?

#### Output

- mapping of current `conversation_state` fields to AG-UI concepts
- proposed checkpoint envelope for durable restore
- clear rule for when a checkpoint is emitted

#### Exit Criteria

- we can explain how a thread refresh restores:
  - completed text-only runs
  - completed server-tool runs
  - paused/resumable client-action runs

### Spike B — Interactive Tool Replay Model

#### Goal

Decide where current semantic replay state (`replayState.toolTraces`) lives in AG-UI terms.

#### Questions

- Should replayable semantic UI state use `ActivitySnapshot` / `ActivityDelta`?
- Should it use `StateSnapshot` / `StateDelta`?
- Should it use AG-UI `Custom` events?
- Should tool replay be represented as frontend-only activity messages?

#### Output

- one canonical model for semantic tool replay
- one restore story for:
  - `pick_card`
  - mermaid
  - future custom interactive tools

#### Current Decision

- semantic replay state is represented as AG-UI-aligned custom state, not plain messages
- current implementation uses `ag_ui_state_snapshot.state.replay` as the transitional home for replay traces
- durable replay consumes that state and rebuilds semantic UI patches without requiring replay-time identity invention

#### Exit Criteria

- we can explain exactly how a completed `pick_card` card UI and a mermaid render survive refresh without bespoke replay heuristics

### Spike C — Pause/Resume Handoff Model

#### Goal

Model current handoff / elicitation semantics using AG-UI core plus the smallest necessary extension surface.

#### Questions

- Can `elicit_request` become a plain frontend-defined AG-UI tool workflow?
- Is `isomorphic_handoff` best modeled as a suspended tool execution with resumable state?
- Do we need a custom `pendingClientAction` event/state family?
- What identity anchors pause/resume: `toolCallId`, `runId`, `threadId`, or all three?

#### Output

- canonical model for paused client action / resumed server continuation
- recommended custom event or state schema if AG-UI core is insufficient

#### Current Decision

- pause/resume is modeled as AG-UI core tool lifecycle plus custom pending client action state
- current implementation uses `ag_ui_state_snapshot.state.pendingClientActions`
- `kind: 'handoff'` represents suspended server-authoritative client handoff
- `kind: 'elicit'` represents pending elicitation input
- stable identity is anchored on `toolCallId`, with `threadId` and `runId` carried by the enclosing AG-UI run metadata

#### Exit Criteria

- we can model `pick_card` end-to-end, including refresh during pending and after completion

## Vertical Slices

After the spikes, implementation should proceed as vertical slices that each deliver a working AG-UI-backed flow.

### Slice 1 — Text-Only AG-UI Threads

#### Goal

Prove a full text-only threaded conversation can run and refresh over AG-UI lifecycle + message events.

#### Scope

- user message send
- assistant streamed text
- run lifecycle events
- durable replay and refresh

#### Likely Files

- `packages/framework/src/lib/chat/session/streaming.ts`
- `packages/framework/src/handler/durable/handler.ts`
- `packages/framework/src/lib/chat/session/event-mapper.ts`
- `packages/framework/src/lib/chat/session/durable-history.ts`

#### Acceptance

- text thread send/refresh works end-to-end
- AG-UI run/message events are persisted and replayed

#### Current Status

- transitional AG-UI run and message lifecycle events are now emitted on the durable wire:
  - `ag_ui_run_started`
  - `ag_ui_messages_snapshot`
  - `ag_ui_text_message_start`
  - `ag_ui_text_message_content`
  - `ag_ui_text_message_end`
- existing client rendering remains on the legacy patch path for now to avoid live duplication during migration

#### Dependencies

- Spike A

### Slice 2 — Server Tool Calls Over AG-UI

#### Goal

Model standard server-only tools over AG-UI message + tool lifecycle without touching handoff yet.

#### Scope

- assistant tool call
- tool result
- assistant follow-up
- durable replay

#### Likely Files

- `packages/framework/src/handler/durable/chat-engine.ts`
- `packages/framework/src/lib/chat/types.ts`
- `packages/framework/src/lib/chat/session/transcript.ts`
- `packages/framework/src/lib/chat/session/durable-history.ts`

#### Acceptance

- server-only tool flows replay after refresh
- no custom handoff event dependency for this slice

#### Dependencies

- Spike A

### Slice 3 — Durable Serialization and Compaction

#### Goal

Make durable storage AG-UI-native and compactable without losing observable semantics.

#### Scope

- AG-UI event serialization
- append-only event log
- snapshot/compaction rules
- run/thread lineage (`threadId`, `runId`, `parentRunId`)

#### Likely Files

- `packages/framework/src/handler/durable/handler.ts`
- `packages/framework/src/lib/chat/session/durable-history.ts`
- durable storage and read paths

#### Acceptance

- serialized AG-UI stream round-trips cleanly
- compaction preserves replay behavior

#### Current Status

- transitional AG-UI checkpoint and state snapshot events are now emitted and persisted:
  - `ag_ui_checkpoint`
  - `ag_ui_state_snapshot`
- durable replay understands `ag_ui_checkpoint` and custom pending client action state
- compaction is not implemented yet, but the serialization groundwork is in place and replay parity remains green

#### Dependencies

- Spike A

### Slice 4 — Client Adapter Bridge

#### Goal

Drive the current client reducer/rendering pipeline from AG-UI events without rewriting the entire UI stack immediately.

#### Scope

- AG-UI event -> current patch/reducer bridge
- message snapshots
- tool lifecycle mapping

#### Likely Files

- `packages/framework/src/lib/chat/session/event-mapper.ts`
- `packages/framework/src/lib/chat/state/**`
- `packages/framework/src/react/chat/**`

#### Acceptance

- existing UI still works while protocol becomes AG-UI-backed
- reducer black-box tests cover AG-UI input

#### Dependencies

- Slices 1 and 2 interfaces

### Slice 5 — Interactive Replay / Activity Model

#### Goal

Make custom semantic UI replay AG-UI-native.

#### Scope

- completed `pick_card` replay
- mermaid replay
- future semantic tool UI state

#### Likely Files

- `packages/framework/src/lib/chat/session/durable-history.ts`
- `packages/framework/src/lib/chat/state/**`
- `apps/yo-chat/src/routes/chat/threaded/index.tsx`

#### Acceptance

- completed card picks survive refresh
- mermaid survives refresh
- replay model is based on AG-UI state/activity/custom semantics, not ad hoc patch rebuilding

#### Dependencies

- Spike B
- Slice 3

### Slice 6 — Handoff / Elicit / Resume

#### Goal

Replace current custom pause/resume wire semantics with AG-UI core plus a small, explicit extension.

#### Scope

- `isomorphic_handoff`
- `elicit_request`
- client response submission
- resumed server continuation
- pending refresh restore

#### Likely Files

- `packages/framework/src/handler/durable/chat-engine.ts`
- `packages/framework/src/lib/chat/session/create-session.ts`
- `packages/framework/src/lib/chat/session/streaming.ts`
- client tool runtime / session logic

#### Acceptance

- pending `pick_card` survives refresh
- resumed handoff completes correctly
- multi-turn interactive tool flows behave correctly after reload

#### Dependencies

- Spike C
- Slice 5

## Concurrency Plan

### Wave 0 — Unknown Burn-Down

These can run concurrently:

- Spike A — Checkpoint Model
- Spike B — Interactive Tool Replay Model
- Spike C — Pause/Resume Handoff Model

### Wave 1 — Core Parallel Work

These can begin once the relevant spike outputs exist:

- Slice 1 — Text-Only AG-UI Threads
- Slice 2 — Server Tool Calls Over AG-UI
- Slice 3 — Durable Serialization and Compaction

### Wave 2 — Integration Parallel Work

- Slice 4 — Client Adapter Bridge
- Slice 5 — Interactive Replay / Activity Model

### Wave 3 — Hardest Custom Flow

- Slice 6 — Handoff / Elicit / Resume

## Dependency Graph

- Spike A -> Slices 1, 2, 3
- Spike B -> Slice 5
- Spike C -> Slice 6
- Slice 1 + Slice 2 -> Slice 4
- Slice 3 + Spike B -> Slice 5
- Slice 5 + Spike C -> Slice 6

## Recommended Implementation Order

If we want to de-risk unknowns before investing deeply:

1. Spike A
2. Spike B
3. Spike C
4. Slice 1
5. Slice 2
6. Slice 3
7. Slice 4
8. Slice 5
9. Slice 6

If concurrency is available, use the wave plan instead.

## Suggested Owners / Parallelization

- Team A: Spike A + Slice 3
- Team B: Spike B + Slice 5
- Team C: Spike C + Slice 6
- Team D: Slice 1 + Slice 4
- Team E: Slice 2

## Key Reference Flow for De-Risking

Use `pick_card` as the canonical reference flow for pause/resume and interactive replay:

- `apps/yo-chat/src/tools/pick-card.tsx`
- `apps/yo-chat/e2e/threaded-chat.spec.ts`

Why:

- it includes server-first handoff
- it includes client-side interactive selection
- it includes durable replay of semantic UI state
- it already has refresh acceptance coverage

## Acceptance Ladder

We should aim to get green in this order:

1. text-only AG-UI thread refresh
2. server-tool AG-UI refresh
3. durable serialization/compaction parity
4. completed card-pick + mermaid refresh under AG-UI
5. pending/resumed handoff refresh under AG-UI

## Finalization Checklist

Before starting broad implementation, each spike should produce a written decision for review:

- checkpoint envelope
- semantic replay location
- pause/resume extension shape

Once those three are finalized, the implementation slices can proceed with much lower risk.
