# Design: Repeated Plugin Elicitation Flow State Cleanup Design

## Status
Draft

## Overview

The `book_flight` MCP plugin currently regresses when a user completes one booking flow and then starts a second booking flow in the same chat session. The second flow reaches `SeatPicker`, but confirming the return seat does not advance the visible UI out of the interactive SeatPicker state. Diagnostic instrumentation showed that the click handler can be invoked, but the visible interactive emission may be stale from the previous tool call rather than the currently active elicit handler.

This design fixes the state lifecycle for plugin elicitation UI by ensuring client-side plugin emissions are marked complete when users respond, completed plugin elicits are removed from pending tracking when the server emits a tool result, and duplicate assistant message IDs are handled defensively. The goal is to make repeated plugin elicitation flows deterministic: after a user responds to an emission, the exact emission they interacted with becomes non-interactive, the owning elicit handler completes, and subsequent tool calls render fresh UI that cannot be confused with prior tool-call UI.

## Goals

- Ensure responding to a plugin-rendered emission transitions that emission from `pending` to `complete` in local React state before or while the elicit handler resumes.
- Ensure stale plugin elicit tracking is cleared when the corresponding tool call completes.
- Prevent duplicate assistant message IDs from causing React reconciliation instability or duplicated visible UI.
- Preserve completed booking history and visible final booking confirmations.
- Keep the fix framework-level, so all MCP plugin tools using `useElicitExecutor` benefit, not only `book_flight`.
- Keep diagnostic code temporary and out of the shipped implementation.

## Non-Goals

- Do not redesign the MCP plugin tool API, `ctx.elicit()`, or `ctx.render()`.
- Do not change the `book_flight` domain flow, mock flight data, seat map, or LLM prompting behavior.
- Do not change the public shape of `ChatMessage`, `ChatEmission`, or `PluginElicit` unless a later specification explicitly requires it.
- Do not make the e2e test independent of model/tool-calling behavior beyond existing robustness helpers.
- Do not introduce persistent storage or server-side session retention changes.

## Requirements

- [ ] The repeated-flow regression test `can complete outbound and return bookings in the same chat session` must pass.
- [ ] A plugin emission's exposed `onRespond` callback must mark that emission complete in React-local emission state even when a UI renders `emission.onRespond` directly and does not call `respondToEmission`.
- [ ] After an emission response, the rendered component must receive `disabled={true}` and the selected `response` value on the next render.
- [ ] A completed plugin tool call must not leave its elicit tracking in `state.pendingElicits`.
- [ ] Assistant messages with an existing ID must be replaced or ignored rather than appended as duplicate IDs.
- [ ] Empty assistant-final placeholder messages must not be appended in a way that later conflicts with the real final assistant message for the same turn.
- [ ] Completed historical tool UI may remain visible as non-interactive history, but it must not expose pending controls or live response callbacks.
- [ ] The fix must not break single booking flow tests, component detail tests, or other MCP plugin tool flows such as tic-tac-toe/play-ttt.
- [ ] The implementation must not ship temporary debug logging added during diagnosis.

## Design Decisions

### Decision 1: Complete local plugin emissions at the source callback

- **Context**: Plugin elicitation handlers run client-side in `useElicitExecutor`. Their `ctx.render()` calls dispatch local `tool_emission` patches with a direct `respond` callback. The route UI derives `emission.onRespond` and passes it directly to components. Because this path bypasses `useChatSession.respondToEmission`, local emission state is not guaranteed to receive `tool_emission_response`, so an already answered emission can remain `pending` with a live callback.
- **Options considered**:
  1. Require every app route to call `session.respondToEmission(callId, emissionId, value)` instead of `emission.onRespond`.
     - Pros: Uses an existing API path.
     - Cons: Requires every consumer to change rendering code; easy for future apps to misuse; makes the `ChatEmission.onRespond` contract misleading.
  2. Wrap `onRespond` during `deriveMessages`.
     - Pros: Centralizes behavior for derived messages.
     - Cons: `deriveMessages` is intentionally framework-agnostic and pure; it does not currently have a dispatch dependency.
  3. Wrap the local emission `respond` callback inside `useElicitExecutor.renderEmission` so it dispatches `tool_emission_response` before resuming the handler.
     - Pros: Fixes all consumers of plugin emissions; keeps the lifecycle near the source of the local emission; preserves the current `ChatEmission.onRespond` API; no route changes required.
     - Cons: `useElicitExecutor` becomes responsible for both resuming the handler and updating local emission status.
- **Choice**: Option 3.
- **Rationale**: The callback handed to UI is the canonical response path for plugin emissions. It should be self-contained and update its own lifecycle state before resuming the plugin handler. This eliminates stale interactive controls without relying on app-specific rendering conventions.

### Decision 2: Emit elicit completion when a plugin tool call produces a terminal result

- **Context**: `elicit-reducer.ts` supports `elicit_complete`, and `chat-state.ts` documents that completed tools should remove pending elicit tracking. However, no current producer emits `elicit_complete`. Old responded elicits can remain in `pendingElicits`, which keeps historical elicit state live in derivation and complicates repeated tool-call rendering.
- **Options considered**:
  1. Leave pending elicits in state forever but rely on `status: responded` to avoid re-execution.
     - Pros: Minimal change.
     - Cons: Contradicts the state model; stale state grows across turns; makes debugging repeated flows harder.
  2. Have `useElicitExecutor` remove pending elicits immediately after it calls `respondToElicit`.
     - Pros: Clears client state quickly.
     - Cons: The server may respond with another elicit in the same tool call; clearing too early can lose pending lifecycle context.
  3. Emit `elicit_complete` from stream/event mapping when the tool call reaches a terminal result/error/cancellation event.
     - Pros: Matches the reducer's intended lifecycle; clears only after the server-side tool call is terminal; works for multi-step elicits.
     - Cons: Requires careful handling so the current streaming parts retain any historical plugin elicit display they need.
- **Choice**: Option 3.
- **Rationale**: The server stream is authoritative for tool-call completion. Clearing pending elicits on terminal tool-call events preserves multi-step elicitation while preventing completed sessions from polluting future turns.

### Decision 3: Deduplicate assistant messages by ID in reducers and avoid empty final placeholders

- **Context**: Diagnostic runs showed React warnings for duplicate message keys such as `assistant:final:<callId>`. The browser request history also showed an empty assistant-final message followed later by a real assistant-final message with the same ID. Duplicate message IDs can cause React to reuse or reorder stale children, including old interactive emissions.
- **Options considered**:
  1. Only fix the upstream code path that creates the empty placeholder.
     - Pros: Addresses the immediate source.
     - Cons: Leaves reducers vulnerable to future duplicate assistant patches from replay/reconnect paths.
  2. Only make the reducer replace existing assistant messages by ID.
     - Pros: Defensive and simple.
     - Cons: Still allows unnecessary empty placeholder messages to be created and sent in request history.
  3. Do both: avoid appending empty assistant-final placeholders and make assistant message reduction idempotent by ID.
     - Pros: Removes the known bad source and hardens state against future duplicates; aligns with existing `user_message` / `history_message` de-dupe behavior.
     - Cons: Slightly broader change.
- **Choice**: Option 3.
- **Rationale**: Message IDs are identity, not append-only sequence numbers. Reducers should treat repeated IDs as updates, and the session layer should avoid introducing empty final assistant messages for turns that are still awaiting tool output.

### Decision 4: Keep completed emissions visible but non-interactive

- **Context**: Historical tool UI is useful for explaining how a user reached a result. Removing all completed emissions would make prior choices disappear and could degrade the chat transcript.
- **Options considered**:
  1. Remove completed emissions from `toolEmissions` entirely.
     - Pros: Prevents stale UI from being clickable.
     - Cons: Loses useful history; may break tests/components that expect `response` to render.
  2. Keep completed emissions in state with `status: complete`, `response`, and no `respond` callback.
     - Pros: Preserves history while preventing interactions; matches `SeatPicker`'s existing `disabled && response` render path.
     - Cons: Requires components to respect `disabled`; existing framework examples already do.
- **Choice**: Option 2.
- **Rationale**: The framework contract already passes `disabled={emission.status !== 'pending'}` and `response={emission.response}`. Marking emissions complete is the least disruptive lifecycle fix.

### Decision 5: Use the repeated book_flight e2e as the primary regression guard plus focused unit tests

- **Context**: The regression is visible only when a full plugin flow completes and another flow begins in the same chat session. It spans React state, stream mapping, plugin handlers, durable plugin sessions, and app rendering.
- **Options considered**:
  1. Rely only on the Playwright e2e test.
     - Pros: Exercises the real behavior.
     - Cons: Slower and model-dependent; failures can be harder to localize.
  2. Add only unit tests around reducers/hooks.
     - Pros: Fast and deterministic.
     - Cons: May miss integration failures across the plugin/runtime/UI boundary.
  3. Keep the e2e regression and add targeted tests for emission completion, elicit cleanup, and assistant-message dedupe.
     - Pros: Covers both real integration and deterministic state transitions.
     - Cons: More tests to maintain.
- **Choice**: Option 3.
- **Rationale**: The e2e test proves the user-visible bug is fixed; focused tests make the lifecycle guarantees explicit and protect against regressions in smaller components.

## Proposed Implementation Approach

1. In `packages/framework/src/react/chat/useElicitExecutor.ts`, update the local `respond` callback created by `renderEmission()` to dispatch a `tool_emission_response` patch with `callId`, `emissionId`, and `response` before or immediately after calling `responseSignal.send(value)`. The callback must be idempotent enough that double-clicks do not resume the same handler twice.
2. In the stream/event mapping path (`packages/framework/src/lib/chat/session/event-mapper.ts`), emit `elicit_complete` when a terminal `ag_ui_tool_call_result` or `ag_ui_tool_call_error` is observed for a call ID that may have plugin elicits. If cancellation is represented separately in the stream, handle that terminal event too.
3. In assistant message reduction (`packages/framework/src/lib/chat/state/reducers/streaming-parts-reducer.ts` and/or shared core message handling), replace an existing assistant message with the same ID rather than appending a duplicate.
4. In session sync/finalization (`packages/framework/src/lib/chat/session/create-session.ts` and `turn-manager.ts`), avoid appending assistant-final messages with empty content during elicit/checkpoint flows. Only append a final assistant message when there is actual assistant content or when required by provider protocol with a unique non-conflicting ID.
5. Add targeted tests for:
   - local plugin emission response transitions pending → complete;
   - `elicit_complete` removes pending elicit tracking after tool result;
   - duplicate assistant IDs are de-duped/replaced;
   - the repeated `book_flight` e2e passes.
6. Remove all temporary diagnostic logging before finalizing the fix.

## Constraints

- Existing app routes pass `emission.onRespond` directly to components; the fix must preserve that contract.
- `deriveMessages` is framework-agnostic and should remain pure.
- Multi-step plugin tools can emit more than one elicitation for the same call ID; cleanup must not happen until a terminal tool-call event.
- Some historical completed components render selected state using `disabled` and `response`; the fix must continue to provide both.
- The e2e test uses a local LLM/tool-calling stack and can take up to three minutes.
- Existing project instruction requires touched-code quality gates and all e2e tests in all applications before session completion; full execution may need coordination because e2e suites are expensive.

## Dependencies

- `apps/yo-chat/e2e/book-flight.spec.ts`: regression test and end-to-end verification.
- `apps/yo-chat/src/tools/book-flight/components/SeatPicker.tsx`: demonstrates the expected `disabled && response` completed-state behavior.
- `packages/framework/src/react/chat/useElicitExecutor.ts`: source of client-side plugin emission callbacks.
- `packages/framework/src/react/chat/useChatSession.ts`: local emission reducer and response action handling.
- `packages/framework/src/lib/chat/state/reducers/elicit-reducer.ts`: consumes `elicit_complete`.
- `packages/framework/src/lib/chat/state/reducers/tool-emissions-reducer.ts`: server-side emission lifecycle reference.
- `packages/framework/src/lib/chat/state/reducers/streaming-parts-reducer.ts`: assistant message reduction and finalized streaming parts.
- `packages/framework/src/lib/chat/session/event-mapper.ts`: maps durable stream events to state patches.
- `packages/framework/src/lib/chat/session/create-session.ts` and `turn-manager.ts`: synchronize conversation state/history across elicit continuations.
- `packages/framework/src/handler/durable/chat-engine.ts`: source of AG-UI checkpoint/result events for plugin calls.

## Open Questions

None. The diagnostic evidence and existing state model are sufficient to proceed to a normative specification.

## Research Notes

### Reproduction

Command used:

```bash
pnpm -C apps/yo-chat test:e2e --grep "can complete outbound and return bookings"
```

Observed behavior:

- First `book_flight` flow completes.
- Second `book_flight` flow reaches `SeatPicker`.
- Selecting return seat `3C` reveals `Confirm Seat 3C`.
- Clicking `Confirm Seat 3C` leaves the confirm button visible and the test fails:

```text
Return booking: confirming seat 3C should leave the interactive SeatPicker state
Expected: not visible
Received: visible
```

### Diagnostic findings

Temporary instrumentation was used only for diagnosis and then removed. It showed:

- The second flow starts a new active elicit handler for a new call ID.
- The DOM still repeatedly renders a stale pending SeatPicker emission for the first call ID after the first booking completes.
- When the return SeatPicker confirm button is clicked, the emitted response can be associated with the stale first call's `req:2` emission rather than the active return call's `req:2` emission.
- The active return `pickSeat` handler does not complete, so no server continuation advances the return booking.
- The browser logs React duplicate-key warnings for `assistant:final:<firstCallId>` after the first booking completes.
- A diagnostic Playwright request capture showed an empty `assistant:final:<firstCallId>` message followed later by a real final assistant message with the same ID.

### Code evidence

- `useElicitExecutor.renderEmission()` dispatches local `tool_emission` patches with a direct `respond` callback that only calls `responseSignal.send(value)`.
- `useChatSession.respondToEmission()` would mark local emissions complete via `tool_emission_response`, but app renderers commonly use `emission.onRespond` directly from derived messages and do not call `respondToEmission`.
- `localEmissionReducer` already supports `tool_emission_response` by setting status to `complete`, recording `response`, and removing `respond`.
- `elicit-reducer.ts` supports `elicit_complete`, but repository search found no producer for that patch.
- `streaming-parts-reducer.ts` appends `assistant_message` patches without de-duping by ID, while the core reducer already de-dupes `user_message` and `history_message`.

### Why this explains the regression

The first completed flow leaves a stale pending local emission and stale elicit state. Duplicate assistant IDs then make React reconciliation unstable and can place the stale interactive component later in DOM order than the active component. The e2e helper intentionally clicks the latest matching seat/confirm controls to target the active flow, but the latest controls may actually belong to the stale first emission. Completing emissions at response time and deduping assistant identity removes the stale interactive surface and stabilizes repeated plugin flows.
