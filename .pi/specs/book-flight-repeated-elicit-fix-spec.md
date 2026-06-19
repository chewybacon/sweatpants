# Normative Specification: Repeated Plugin Elicitation Flow State Cleanup Specification

## Status
Draft

## Abstract

This specification defines normative requirements for fixing repeated MCP plugin elicitation flows by completing local plugin emissions on response, clearing completed plugin elicit tracking on terminal tool events, preventing duplicate assistant message identities, and preserving completed tool UI as non-interactive history.

## 1. Introduction

### 1.1 Purpose

This specification exists to make repeated MCP plugin elicitation flows deterministic in the React chat framework. A completed plugin flow MUST NOT leave stale pending UI emissions or duplicate assistant message identities that can interfere with later plugin calls in the same chat session. The immediate regression is the `book_flight` flow where a user can complete an outbound booking, start a return booking, reach `SeatPicker`, and then fail to advance after confirming the return seat because stale interactive UI from the prior tool call remains active.

### 1.2 Scope

This specification covers:

- Client-side lifecycle behavior for plugin emissions produced by `useElicitExecutor`.
- Local React emission state transitions after plugin UI responses.
- Pending plugin elicit cleanup after terminal tool-call stream events.
- Assistant message identity deduplication and empty assistant-final placeholder handling.
- Preservation of completed historical plugin UI as non-interactive transcript state.
- Regression and compatibility expectations for `book_flight` and other MCP plugin tools.

This specification does not cover:

- Redesigning the MCP plugin API, `ctx.elicit()`, `ctx.render()`, or plugin handler registration.
- Changing `book_flight` domain data, seat maps, prompts, or LLM behavior.
- Changing public `ChatMessage`, `ChatEmission`, or `PluginElicit` data shapes.
- Changing durable plugin session storage or retention semantics.
- Making e2e tests independent of the local LLM/tool-calling stack.

### 1.3 Terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in RFC 2119.

- **Plugin emission**: A `ToolEmissionState`/`ChatEmission` created by a client-side plugin elicitation handler through `ctx.render()` inside `useElicitExecutor`.
- **Local emission state**: The React-local `localEmissions` state managed by `useChatSession` for client-side plugin handler emissions.
- **Plugin elicit tracking**: Entries in `ChatState.pendingElicits` that represent plugin elicitation requests awaiting or recording a response.
- **Terminal tool-call event**: A stream event indicating that a tool call is complete, errored, or cancelled and will not emit additional elicits for that call ID.
- **Assistant-final placeholder**: An assistant message with an ID such as `assistant:final:<turnKey>` and empty content emitted before the actual final assistant content for the same turn.

## 2. Functional Requirements

### 2.1 Plugin Emission Response Lifecycle

#### REQ-001: Direct Plugin Emission Responses Complete Local State

When a plugin emission's exposed `onRespond` callback is invoked, the framework MUST update the corresponding local emission state entry to `status: 'complete'`, MUST store the response value on that emission, and MUST remove the live `respond` callback from that emission.

**Rationale**: Application renderers pass `emission.onRespond` directly to components. The callback is therefore the canonical response path and MUST complete its own local lifecycle instead of relying on consumers to call a separate helper.

**Acceptance Criteria**:

- [ ] Invoking `emission.onRespond(value)` causes the local emission reducer to receive or otherwise apply an equivalent `tool_emission_response` update for the same `callId` and `emissionId`.
- [ ] The updated local emission has `status: 'complete'`.
- [ ] The updated local emission has `response` equal to the value passed to `onRespond`.
- [ ] The updated local emission no longer exposes a callable `respond`/`onRespond` callback in derived messages.

#### REQ-002: Plugin Emission Response Resumes the Correct Handler

When a plugin emission's exposed `onRespond` callback is invoked, the framework MUST resume the specific elicit handler instance that created that emission and MUST preserve the original `callId`, `elicitId`, and `emissionId` association.

**Rationale**: Repeated plugin flows can have multiple emissions with visually similar controls. The response MUST resume the handler that produced the interacted emission, not a stale or different handler.

**Acceptance Criteria**:

- [ ] A response for `callA:req:2-em-1` resumes the handler waiting on `callA:req:2-em-1`.
- [ ] A response for `callB:req:2-em-1` does not resume or mutate `callA:req:2-em-1` except through independent historical rendering.
- [ ] The result passed to `respondToElicit` uses the `sessionId`, `callId`, and `elicitId` of the handler's own `ElicitState`.

#### REQ-003: Plugin Emission Response Handling Is Idempotent

A plugin emission response callback MUST NOT resume the same handler more than once for the same emission, even if the UI triggers the callback multiple times.

**Rationale**: Users may double-click a confirmation button, and React may keep an event handler callable briefly before the next render. Duplicate sends can corrupt a suspended generator or send repeated elicit responses.

**Acceptance Criteria**:

- [ ] Calling the same emission response callback twice results in at most one handler resume.
- [ ] Calling the same emission response callback twice results in at most one `respondToElicit` command for that elicit.
- [ ] The local emission remains `complete` with the first accepted response value after duplicate invocations.

#### REQ-004: Completed Emissions Render Disabled State

After a plugin emission response is recorded, derived chat messages MUST expose the emission with `status: 'complete'`, MUST include the recorded `response`, and MUST NOT expose `onRespond` for that emission.

**Rationale**: Existing components such as `SeatPicker` render completed UI based on `disabled` and `response`. Derived message state must make completed historical UI non-interactive.

**Acceptance Criteria**:

- [ ] A route rendering `disabled={emission.status !== 'pending'}` passes `disabled={true}` after response.
- [ ] A route rendering `response={emission.response}` receives the selected response value after response.
- [ ] A completed historical SeatPicker renders its selected-seat summary rather than an enabled confirm button.

### 2.2 Plugin Elicit Tracking Lifecycle

#### REQ-005: Terminal Tool Results Clear Pending Elicit Tracking

When the stream mapper observes a terminal successful tool result for a plugin tool call, it MUST emit or apply an `elicit_complete` state update for that tool call ID before the turn is considered complete.

**Rationale**: `pendingElicits` is intended to track active or awaiting plugin elicits. Completed tool calls must not remain in pending tracking and pollute later turns.

**Acceptance Criteria**:

- [ ] After an `ag_ui_tool_call_result` for call ID `callX`, `state.pendingElicits[callX]` is absent.
- [ ] The cleanup happens after all elicits for the call have either been responded to or superseded by the terminal result.
- [ ] The cleanup does not remove pending elicits for other active call IDs.

#### REQ-006: Terminal Tool Errors Clear Pending Elicit Tracking

When the stream mapper observes a terminal tool error for a plugin tool call, it MUST emit or apply an `elicit_complete` state update for that tool call ID.

**Rationale**: Failed plugin tool calls are also terminal and must not leave stale pending UI or elicit state.

**Acceptance Criteria**:

- [ ] After an `ag_ui_tool_call_error` for call ID `callX`, `state.pendingElicits[callX]` is absent.
- [ ] Existing error rendering for the tool call remains visible.
- [ ] The cleanup does not hide or suppress the error message.

#### REQ-007: Multi-Step Elicits Are Not Cleared Before Terminal Events

The framework MUST NOT remove `pendingElicits[callId]` solely because one elicit in a multi-step plugin flow has been responded to if the tool call has not produced a terminal event.

**Rationale**: `book_flight` and other plugin tools may ask for a flight and then a seat in the same tool call. Clearing on the first response would break subsequent elicits.

**Acceptance Criteria**:

- [ ] Responding to `pickFlight` does not remove `pendingElicits[callId]` if `pickSeat` is subsequently emitted.
- [ ] `useElicitExecutor` can observe and execute the next pending elicit for the same call ID.
- [ ] Cleanup occurs only after terminal result/error/cancellation for that call ID.

#### REQ-008: Completed Historical Elicit Data Does Not Re-Execute Handlers

After a tool call has completed, historical elicit or emission data MAY remain visible in transcript state, but it MUST NOT appear as pending executable work to `useElicitExecutor`.

**Rationale**: Historical display and executable pending state are separate concerns. Re-executing old handlers causes duplicate UI and stale callbacks.

**Acceptance Criteria**:

- [ ] `useElicitExecutor` does not start a task for an elicit belonging to a completed tool call.
- [ ] Completed elicit data, if rendered from finalized parts, is rendered without a live pending callback.
- [ ] Starting a new plugin tool call creates new pending elicit tracking independent of completed historical elicits.

### 2.3 Assistant Message Identity and Transcript State

#### REQ-009: Assistant Message Reduction Is Idempotent by ID

When reducing an `assistant_message` patch whose message has an ID already present in `state.messages`, the reducer MUST replace the existing message with the new message or otherwise update it in place, and MUST NOT append a second message with the same ID.

**Rationale**: Duplicate assistant message IDs cause React duplicate key warnings and unstable reconciliation that can surface stale interactive UI.

**Acceptance Criteria**:

- [ ] Reducing two assistant messages with the same ID leaves exactly one message with that ID in `state.messages`.
- [ ] The retained message contains the latest content from the newer patch.
- [ ] Finalized parts associated with the message ID remain accessible after replacement.

#### REQ-010: Empty Assistant-Final Placeholders Do Not Conflict With Final Content

The session synchronization/finalization path MUST NOT append an empty assistant-final message with an ID that will later be used for non-empty final assistant content in the same turn.

**Rationale**: Empty placeholders such as `assistant:final:<callId>` can later collide with the true final message for the same tool-call turn.

**Acceptance Criteria**:

- [ ] A conversation awaiting plugin elicitation does not add an empty `assistant:final:<callId>` message that later duplicates a final response message.
- [ ] If an empty assistant message is required by a provider protocol or replay path, it uses an identity that cannot conflict with the final assistant content message.
- [ ] Completing a plugin tool call yields no React duplicate-key warning for `assistant:final:<callId>`.

#### REQ-011: Tool-Call Transcript Shape Remains Provider-Compatible

The framework MUST preserve a provider-compatible transcript sequence for plugin tool calls: user message, assistant tool-call message, tool result message, and final assistant message when final assistant content exists.

**Rationale**: Fixing duplicate assistant-final messages must not break provider protocol expectations for tool-call conversations.

**Acceptance Criteria**:

- [ ] Elicit continuation requests include the assistant tool-call message needed to associate subsequent tool results with the original tool call.
- [ ] Completed plugin calls include a tool result message with the correct `tool_call_id`.
- [ ] Final assistant content is preserved as an assistant message when the provider returns it.

### 2.4 Repeated Flow Behavior

#### REQ-012: Repeated Book Flight Flow Completes in One Chat Session

The `book_flight` demo MUST allow a user to complete an outbound booking and a return booking in the same chat session.

**Rationale**: This is the user-visible regression that motivated the fix.

**Acceptance Criteria**:

- [ ] The e2e test `can complete outbound and return bookings in the same chat session` passes.
- [ ] The outbound flow completes after flight selection and seat confirmation.
- [ ] The return flow completes after flight selection and seat confirmation.
- [ ] The final chat contains at least two booking confirmations or equivalent ticket/confirmation messages.

#### REQ-013: Confirming the Second Seat Leaves Interactive SeatPicker State

In a repeated `book_flight` flow, after the user selects return seat `3C` and clicks `Confirm Seat 3C`, the visible matching confirm button MUST become not visible, disabled, or otherwise non-interactive within the test timeout.

**Rationale**: The prior failure mode was specifically that the second confirm button remained visible and interactive after click.

**Acceptance Criteria**:

- [ ] The Playwright assertion `expect(confirmSeatButton).not.toBeVisible({ timeout: 5000 })` passes or is replaced by an equivalent assertion that proves non-interactivity.
- [ ] The runtime proceeds to send or process the elicit response for the return `pickSeat` handler.
- [ ] No stale first-flow SeatPicker is the latest interactive matching control after the return flow reaches `SeatPicker`.

#### REQ-014: Completed Historical Tool UI Remains Non-Interactive

Completed historical plugin UI MAY remain visible in the chat transcript, but it MUST be non-interactive and MUST NOT expose pending controls that can be selected by role/title locators as active controls for the current flow.

**Rationale**: Chat history should remain informative but must not capture future interactions intended for new tool calls.

**Acceptance Criteria**:

- [ ] Completed historical SeatPicker UI displays the selected seat summary or disabled state.
- [ ] Completed historical FlightList UI displays selected/disabled state and cannot submit another response.
- [ ] Playwright locators targeting the latest enabled active seat/confirm controls resolve to the current flow, not a completed flow.

### 2.5 Compatibility and Diagnostics

#### REQ-015: Public API Compatibility

The implementation MUST preserve the public shape of `ChatMessage`, `ChatEmission`, `PluginElicit`, plugin client registrations, `ctx.elicit()`, and `ctx.render()`.

**Rationale**: The fix is a lifecycle correction and must not require application or plugin API migration.

**Acceptance Criteria**:

- [ ] Existing app code that passes `emission.onRespond` directly to a component compiles without changes.
- [ ] Existing plugin handler code using `yield* ctx.render(Component, props)` compiles without changes.
- [ ] Existing consumers of `ChatEmission.status`, `response`, and `onRespond` do not require type changes.

#### REQ-016: No Temporary Debug Logging Ships

The implementation MUST NOT include temporary diagnostic logging, Playwright console tracing, or instrumentation strings introduced to diagnose this regression.

**Rationale**: Debug logging can create noise in tests and production demos and may expose internal state unnecessarily.

**Acceptance Criteria**:

- [ ] Repository search for known diagnostic markers such as `[book-flight-debug]` returns no shipped source matches.
- [ ] The repeated-flow e2e test does not rely on console instrumentation for pass/fail behavior.
- [ ] Browser console output during the repeated-flow e2e does not include React duplicate-key warnings caused by this bug.

#### REQ-017: Existing Plugin Flows Continue to Work

The implementation MUST NOT regress existing single-flow `book_flight` tests or other MCP plugin tool demos that use `useElicitExecutor`.

**Rationale**: The fix is framework-level and affects all client-side plugin emission lifecycles.

**Acceptance Criteria**:

- [ ] Existing `book_flight` e2e tests for FlightList, SeatPicker, and full booking flow pass.
- [ ] Existing unit or e2e tests for tic-tac-toe/play-ttt plugin elicitation flows pass where applicable.
- [ ] Existing tests for emission reducers and message derivation pass.

## 3. Non-Functional Requirements

### NFR-001: Localized State Lifecycle Change

The implementation SHOULD localize emission completion behavior to `useElicitExecutor` and `useChatSession` local emission state rather than requiring app-level rendering changes.

**Rationale**: The framework should provide a safe default lifecycle for all applications using plugin emissions.

**Acceptance Criteria**:

- [ ] `apps/yo-chat/src/routes/chat/flight/index.tsx` does not need to replace direct `emission.onRespond` usage with a different API.
- [ ] New app renderers following existing documentation receive correct complete/non-interactive behavior by default.

### NFR-002: State Growth Bound

The framework SHOULD remove executable pending elicit tracking for completed plugin tool calls to prevent unbounded growth of `state.pendingElicits` across repeated completed flows.

**Rationale**: Repeated flows in long chat sessions should not accumulate stale pending execution state.

**Acceptance Criteria**:

- [ ] After two completed `book_flight` flows, `pendingElicits` does not contain entries for either completed flow.
- [ ] Remaining historical display state, if any, is stored in completed messages/finalized parts rather than executable pending state.

### NFR-003: Deterministic Rendering Under React Reconciliation

The implementation MUST maintain unique message keys in rendered chat message lists for all framework-generated assistant messages.

**Rationale**: Duplicate keys cause unsupported React behavior and can reorder or duplicate interactive components.

**Acceptance Criteria**:

- [ ] A repeated plugin flow produces no duplicate IDs in `messages.map((msg) => msg.id)` for framework-generated assistant messages.
- [ ] React does not warn about duplicate assistant message keys during the repeated `book_flight` e2e.

## 4. Interfaces

### 4.1 Public API Endpoints

No public HTTP API endpoint changes are specified. Existing chat POST requests and durable stream events MUST remain wire-compatible.

### 4.2 Data Models

#### 4.2.1 Local Emission Response Patch

The existing `tool_emission_response` patch shape MUST continue to be used for local plugin emission completion:

```ts
{
  type: 'tool_emission_response'
  callId: string
  emissionId: string
  response: unknown
}
```

The patch semantics MUST be:

- `callId` identifies the owning tool call.
- `emissionId` identifies the specific emission produced by `ctx.render()`.
- `response` stores the UI response value that completed the emission.

#### 4.2.2 Local Completed Emission State

After completion, the local emission state MUST be equivalent to:

```ts
{
  id: string
  callId: string
  toolName: string
  type: 'component'
  payload: unknown
  status: 'complete'
  response: unknown
  timestamp: number
  respond?: never
}
```

The derived `ChatEmission` MUST expose `status: 'complete'`, MUST expose `response`, and MUST NOT expose `onRespond`.

#### 4.2.3 Elicit Completion Patch

The existing `elicit_complete` patch shape MUST be used to clear plugin elicit tracking:

```ts
{
  type: 'elicit_complete'
  callId: string
}
```

Reducers MUST remove `state.pendingElicits[callId]` when this patch is applied.

#### 4.2.4 Assistant Message Identity

Framework-generated assistant message IDs MUST remain unique within `state.messages`. If a new assistant message has an existing ID, the reducer MUST treat the message as an update to that ID rather than as a new list item.

### 4.3 Events

#### 4.3.1 Terminal Tool Result Event Mapping

When mapping an `ag_ui_tool_call_result` stream event, the event mapper MUST emit existing `tool_call_result` behavior and MUST also clear plugin elicit tracking for the event's `toolCallId`.

#### 4.3.2 Terminal Tool Error Event Mapping

When mapping an `ag_ui_tool_call_error` stream event, the event mapper MUST emit existing `tool_call_error` behavior and MUST also clear plugin elicit tracking for the event's `toolCallId`.

#### 4.3.3 Cancellation Events

If a stream event represents plugin tool cancellation as terminal for a `callId`, the mapper SHOULD clear plugin elicit tracking for that `callId` using the same `elicit_complete` semantics.

## 5. Error Handling

### REQ-018: Elicit Cleanup Must Not Suppress Errors

When a terminal error event clears pending elicit tracking, the framework MUST still preserve and render the tool error according to existing error handling behavior.

**Rationale**: Cleanup is a lifecycle operation and must not hide failures from users or tests.

**Acceptance Criteria**:

- [ ] `tool_call_error` patches still update the corresponding tool-call part to `state: 'error'`.
- [ ] Error messages remain visible in the UI.
- [ ] `pendingElicits[callId]` is removed after the error.

### REQ-019: Missing Local Emission During Response Is Safe

If a `tool_emission_response` update is applied for a `callId` or `emissionId` that is no longer present in local emission state, the reducer MUST leave state unchanged and MUST NOT throw.

**Rationale**: Race conditions during unmount, reset, or duplicate clicks should not crash the chat UI.

**Acceptance Criteria**:

- [ ] Dispatching `tool_emission_response` for an unknown `callId` does not throw.
- [ ] Dispatching `tool_emission_response` for an unknown `emissionId` does not throw.
- [ ] Existing known emissions remain unchanged in these cases.

## 6. Security Considerations

### REQ-020: Response Values Must Not Be Logged By Default

The implementation MUST NOT add default logging of plugin emission response payloads, elicit request payloads, session IDs, or model context as part of this fix.

**Rationale**: Elicitation responses may contain user-provided data. The fix should not increase data exposure.

**Acceptance Criteria**:

- [ ] No new `console.log`, `console.warn`, or framework logger calls output response payloads in production/source code for this fix.
- [ ] Tests do not require logging sensitive elicit or response payloads.

### REQ-021: Authorization and Session Semantics Are Unchanged

The implementation MUST NOT alter chat authorization, plugin session lookup authorization, session retention, or durable session identity semantics.

**Rationale**: The regression is a client/state lifecycle issue, not an authorization or session persistence issue.

**Acceptance Criteria**:

- [ ] Chat POST request authentication/authorization behavior remains unchanged.
- [ ] Plugin session IDs and call IDs continue to be generated and validated by existing code paths.
- [ ] No new persistent storage is introduced.

## 7. Migration / Compatibility

### REQ-022: No Application Migration Required

Applications that currently render plugin emissions using `emission.onRespond` MUST continue to work without source changes.

**Rationale**: The framework owns the lifecycle bug and must not require consumers to migrate render code.

**Acceptance Criteria**:

- [ ] `apps/yo-chat/src/routes/chat/flight/index.tsx` can keep its existing emission rendering pattern.
- [ ] Existing examples that pass `onRespond={emission.onRespond}` continue to compile.

### REQ-023: Historical Transcript Compatibility

The implementation MUST preserve existing historical transcript content and final assistant booking confirmations while removing stale executable state.

**Rationale**: Users should still see what happened in earlier turns, including completed selections and confirmations.

**Acceptance Criteria**:

- [ ] Completed booking confirmation messages remain visible after the second booking starts.
- [ ] Completed selection UI, if visible, is non-interactive and displays the recorded response.
- [ ] Final assistant messages are not dropped when duplicate placeholder prevention is applied.

## References

- Design Document: [.pi/specs/book-flight-repeated-elicit-fix-design.md](.pi/specs/book-flight-repeated-elicit-fix-design.md)
- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- Relevant implementation files:
  - `packages/framework/src/react/chat/useElicitExecutor.ts`
  - `packages/framework/src/react/chat/useChatSession.ts`
  - `packages/framework/src/lib/chat/state/reducers/elicit-reducer.ts`
  - `packages/framework/src/lib/chat/state/reducers/streaming-parts-reducer.ts`
  - `packages/framework/src/lib/chat/session/event-mapper.ts`
  - `packages/framework/src/lib/chat/session/create-session.ts`
  - `apps/yo-chat/e2e/book-flight.spec.ts`
