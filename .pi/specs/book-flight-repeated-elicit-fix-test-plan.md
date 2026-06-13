# Test Plan: Repeated Plugin Elicitation Flow State Cleanup Test Plan

## Status
Draft

## 1. Overview

This test plan verifies the repeated plugin elicitation flow state cleanup behavior defined in the approved normative specification.

**Specification**: [.pi/specs/book-flight-repeated-elicit-fix-spec.md](.pi/specs/book-flight-repeated-elicit-fix-spec.md)

The plan focuses on preventing stale interactive plugin UI from completed tool calls, ensuring plugin emission responses complete local state and resume the correct handler once, clearing plugin elicit tracking on terminal tool events, maintaining unique assistant message identity, and proving that `book_flight` can complete outbound and return bookings in the same chat session.

## 2. Test Strategy

### 2.1 Approach

Testing uses three layers:

1. **Unit tests** for reducers and pure state transitions:
   - local emission completion semantics;
   - unknown emission response safety;
   - `elicit_complete` cleanup;
   - assistant message deduplication;
   - terminal event mapping for success and error.
2. **Integration tests** for React chat hook/plugin execution behavior:
   - direct `emission.onRespond` completes local emission state;
   - the correct elicit handler resumes for the correct `callId`/`elicitId`;
   - duplicate callback invocations do not send duplicate elicit responses;
   - multi-step elicits remain active until terminal events.
3. **E2E tests** for user-visible regressions in `apps/yo-chat`:
   - full `book_flight` flow still works;
   - outbound and return bookings complete in one chat session;
   - completed historical UI is non-interactive;
   - no debug instrumentation or duplicate-key warnings are emitted.

### 2.2 Tools

- **Vitest** for unit and integration tests in `packages/framework` and `apps/yo-chat`.
- **@testing-library/react** for React hook/component integration where needed.
- **Playwright** for `apps/yo-chat` e2e tests.
- **rg / static search** for diagnostic logging markers and accidental API changes.
- Existing commands:
  - `pnpm -C packages/framework test`
  - `pnpm -C apps/yo-chat test`
  - `pnpm -C apps/yo-chat test:e2e --grep "book_flight"`
  - `pnpm -C apps/yo-chat test:e2e --grep "can complete outbound and return bookings"`

### 2.3 Coverage Goals

- 100% of normative **MUST** / **MUST NOT** requirements must have at least one test case.
- Practical **SHOULD** requirements must have coverage where observable through state or e2e behavior.
- Error handling and race conditions must include negative tests.
- The repeated `book_flight` e2e must be the final acceptance gate for the visible regression.

## 3. Test Cases

### TC-001: Direct Plugin onRespond Completes Local Emission

- **Requirement**: REQ-001, REQ-004, NFR-001
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A test plugin handler uses `ctx.render(TestComponent, props)` from `useElicitExecutor`.
  - The rendered emission is available through derived chat messages.
- **Steps**:
  1. Render a test chat session with one pending plugin elicit.
  2. Wait for the plugin emission to appear with `status: 'pending'` and `onRespond` defined.
  3. Invoke `emission.onRespond({ selected: 'A' })` directly, without calling `respondToEmission`.
  4. Re-read derived messages and local tool emissions.
- **Expected Result**:
  - The same emission has `status: 'complete'`.
  - The same emission has `response` equal to `{ selected: 'A' }`.
  - The derived emission has no `onRespond` callback.
  - No application route rendering changes are required.

### TC-002: Plugin onRespond Resumes Matching Handler

- **Requirement**: REQ-002
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - Two pending plugin elicits exist with different call IDs: `callA` and `callB`.
  - Each elicit renders a component with a unique emission ID.
  - `respondToElicit` is spied/mocked.
- **Steps**:
  1. Invoke the `onRespond` callback for `callB:req:2-em-1`.
  2. Observe handler completion and `respondToElicit` calls.
  3. Inspect state for `callA` and `callB` emissions.
- **Expected Result**:
  - Only the `callB` handler resumes.
  - `respondToElicit` is called with `callB`'s `sessionId`, `callId`, and `elicitId`.
  - `callA` remains unchanged except for normal independent rendering.

### TC-003: Plugin onRespond Is Idempotent

- **Requirement**: REQ-003
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A pending plugin emission has a live `onRespond` callback.
  - Handler resume and `respondToElicit` are observable via spies.
- **Steps**:
  1. Invoke `emission.onRespond({ seat: '3C' })`.
  2. Immediately invoke the same callback again with `{ seat: '4D' }`.
  3. Flush state updates and handler tasks.
- **Expected Result**:
  - The handler resumes at most once.
  - `respondToElicit` is called at most once.
  - The emission is complete with the first accepted response `{ seat: '3C' }`.
  - No duplicate continuation request is generated.

### TC-004: Completed SeatPicker Receives Disabled State and Response

- **Requirement**: REQ-004, REQ-014, REQ-023
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A `SeatPicker` emission has been completed with `{ row: 2, seat: 'A' }`.
  - The route renders components using `disabled={emission.status !== 'pending'}` and `response={emission.response}`.
- **Steps**:
  1. Render the completed emission through the flight route's `ToolCallBlock` pattern.
  2. Query for the selected seat summary and confirm button.
  3. Query all seat buttons in that historical component.
- **Expected Result**:
  - The component receives `disabled={true}` and `response={ row: 2, seat: 'A' }`.
  - It renders `Selected: Seat 2A` or equivalent completed UI.
  - It does not render an enabled `Confirm Seat 2A` button.
  - Historical controls cannot submit another response.

### TC-005: Successful Tool Result Clears Pending Elicit Tracking

- **Requirement**: REQ-005, NFR-002
- **Type**: Unit
- **Priority**: High
- **Preconditions**:
  - `ChatState.pendingElicits` contains entries for `callX` and `callY`.
- **Steps**:
  1. Apply/mapping-process an `ag_ui_tool_call_result` for `callX`.
  2. Apply resulting patches to the chat reducer.
  3. Inspect `pendingElicits`.
- **Expected Result**:
  - `pendingElicits.callX` is removed.
  - `pendingElicits.callY` remains present.
  - Existing `tool_call_result` behavior for `callX` still occurs.

### TC-006: Tool Error Clears Pending Elicit Tracking and Preserves Error

- **Requirement**: REQ-006, REQ-018
- **Type**: Unit
- **Priority**: High
- **Preconditions**:
  - `ChatState.pendingElicits.callX` exists.
  - A streaming tool-call part for `callX` exists.
- **Steps**:
  1. Apply/mapping-process an `ag_ui_tool_call_error` for `callX` with message `boom`.
  2. Apply resulting patches to the chat reducer.
  3. Inspect `pendingElicits` and streaming/tool-call state.
- **Expected Result**:
  - `pendingElicits.callX` is removed.
  - The tool-call part is marked `state: 'error'`.
  - The error message remains visible/available as `boom`.

### TC-007: Multi-Step Elicit Remains Pending Between Responses

- **Requirement**: REQ-007
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A plugin flow emits `pickFlight`, then after response emits `pickSeat`, then eventually returns a result.
- **Steps**:
  1. Start the plugin flow and wait for `pickFlight`.
  2. Respond to `pickFlight`.
  3. Before a terminal tool result, inspect `pendingElicits[callId]` and wait for `pickSeat`.
- **Expected Result**:
  - `pendingElicits[callId]` is not removed solely by responding to `pickFlight`.
  - `useElicitExecutor` starts/executes the `pickSeat` elicit.
  - Cleanup does not occur until terminal result/error/cancellation.

### TC-008: Completed Historical Elicit Does Not Re-Execute

- **Requirement**: REQ-008
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A plugin call has completed and historical finalized parts remain in chat history.
  - `useElicitExecutor` start/execution is observable via a spy or controlled handler count.
- **Steps**:
  1. Complete a plugin flow with two elicits.
  2. Trigger a new render or send a separate user message.
  3. Observe whether old elicits from the completed call start again.
- **Expected Result**:
  - No handler task starts for the completed call's old elicits.
  - Historical UI, if present, has no live callback.
  - New plugin calls create independent pending elicit tracking.

### TC-009: Assistant Message Reducer Deduplicates by ID

- **Requirement**: REQ-009, NFR-003
- **Type**: Unit
- **Priority**: High
- **Preconditions**:
  - Initial state has no messages.
- **Steps**:
  1. Reduce an `assistant_message` patch with ID `assistant:final:call1` and empty content.
  2. Reduce another `assistant_message` patch with the same ID and content `done`.
  3. Inspect `state.messages` and finalized parts map.
- **Expected Result**:
  - Exactly one message with ID `assistant:final:call1` exists.
  - The message content is `done`.
  - Finalized parts for that ID remain accessible if present.

### TC-010: Elicit Checkpoint Does Not Create Conflicting Empty Assistant-Final Placeholder

- **Requirement**: REQ-010, REQ-011, NFR-003
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A plugin flow reaches an elicit checkpoint before final assistant content exists.
  - Request payloads or session history can be inspected.
- **Steps**:
  1. Start a plugin tool call and stop at the first elicit checkpoint.
  2. Inspect synchronized history/request messages.
  3. Complete the tool call and inspect final history/messages.
- **Expected Result**:
  - The checkpoint history includes the required assistant tool-call message.
  - It does not include an empty `assistant:final:<callId>` that later duplicates final content.
  - Completion includes the tool result message and final assistant message when final content exists.
  - No duplicate assistant IDs are present.

### TC-011: Provider-Compatible Plugin Transcript Shape

- **Requirement**: REQ-011, REQ-021
- **Type**: Integration
- **Priority**: High
- **Preconditions**:
  - A controlled plugin tool emits an elicit and then completes.
  - Outbound messages to the provider/API can be captured.
- **Steps**:
  1. Start plugin call and emit elicit.
  2. Respond to elicit and continue.
  3. Inspect transcript messages used for the post-elicit provider continuation.
- **Expected Result**:
  - The transcript sequence remains user → assistant tool-call → tool result → assistant final when final content exists.
  - The tool result has the original `tool_call_id`.
  - No authorization/session identity behavior changes are observable.

### TC-012: Repeated Book Flight E2E Completes Outbound and Return

- **Requirement**: REQ-012, REQ-013, REQ-014, REQ-023
- **Type**: E2E
- **Priority**: High
- **Preconditions**:
  - Yo-chat dev server is running.
  - Local LLM/tool-calling prerequisites are satisfied.
  - Browser is on `/chat/flight/`.
- **Steps**:
  1. Send: `Use the book_flight tool to book an outbound flight from Los Angeles to New York.`
  2. Select the latest flight card.
  3. Select seat `2A` and click `Confirm Seat 2A`.
  4. Wait for an outbound booking confirmation.
  5. Send: `Great, now use the book_flight tool again to book the return flight from New York to Los Angeles.`
  6. Select the latest return flight card.
  7. Select seat `3C` and click `Confirm Seat 3C`.
  8. Wait for a return booking confirmation.
- **Expected Result**:
  - Both flows complete.
  - The return `Confirm Seat 3C` button leaves the interactive SeatPicker state within 5 seconds.
  - The final chat contains at least two confirmations/tickets.
  - No stale first-flow SeatPicker is the latest active matching control.

### TC-013: Single Book Flight Flow Regression Suite

- **Requirement**: REQ-017
- **Type**: E2E
- **Priority**: High
- **Preconditions**:
  - Yo-chat dev server and LLM/tool-calling prerequisites are available.
- **Steps**:
  1. Run the existing `book_flight` e2e suite or relevant tests for FlightList, SeatPicker, and full booking flow.
  2. Observe failures and logs.
- **Expected Result**:
  - Existing FlightList tests pass.
  - Existing SeatPicker component detail tests pass.
  - Existing single full booking flow passes.

### TC-014: Public Type/API Compatibility Compile Check

- **Requirement**: REQ-015, REQ-022
- **Type**: Unit / Static
- **Priority**: High
- **Preconditions**:
  - Existing app routes and plugin handlers are unchanged.
- **Steps**:
  1. Run TypeScript/Vitest compile checks for `packages/framework` and `apps/yo-chat`.
  2. Confirm `apps/yo-chat/src/routes/chat/flight/index.tsx` still passes `onRespond={emission.onRespond}`.
  3. Confirm plugin handlers using `yield* ctx.render(Component, props)` compile unchanged.
- **Expected Result**:
  - No public type shape change is required.
  - Existing app code compiles without migration.
  - Existing plugin handler code compiles without migration.

### TC-015: No Diagnostic Logging or Duplicate Key Warnings

- **Requirement**: REQ-016, REQ-020, NFR-003
- **Type**: Static + E2E
- **Priority**: High
- **Preconditions**:
  - Implementation changes are present.
- **Steps**:
  1. Run `rg "\[book-flight-debug\]|console\.log|console\.warn"` on touched source areas and inspect intentional logging.
  2. Run the repeated `book_flight` e2e while capturing browser console errors.
  3. Search captured output for `Encountered two children with the same key`.
- **Expected Result**:
  - No diagnostic marker strings remain.
  - No new default logging of elicit response payloads or model context exists.
  - The repeated e2e does not emit duplicate assistant key warnings caused by this bug.

### TC-016: Completed Pending Elicit State Does Not Grow Across Repeated Flows

- **Requirement**: REQ-005, REQ-008, NFR-002
- **Type**: Integration
- **Priority**: Medium
- **Preconditions**:
  - A test harness can inspect `state.pendingElicits` after completed plugin flows.
- **Steps**:
  1. Complete a plugin flow with two elicits.
  2. Complete a second plugin flow with two elicits.
  3. Inspect `state.pendingElicits`.
- **Expected Result**:
  - No entries remain for either completed call ID.
  - Historical display state, if any, is in messages/finalized parts rather than executable pending state.

### TC-017: Existing Tic-Tac-Toe/Play-TTT Plugin Flows Still Work

- **Requirement**: REQ-017
- **Type**: E2E / Integration
- **Priority**: Medium
- **Preconditions**:
  - Relevant game plugin tests are available and app prerequisites are running.
- **Steps**:
  1. Run existing tic-tac-toe/play-ttt plugin flow tests where present.
  2. Complete at least one plugin elicitation interaction.
  3. Observe state and UI completion.
- **Expected Result**:
  - Game plugin elicit handlers still execute.
  - Responding to game UI advances the plugin flow.
  - No stale pending UI from completed game elicits remains interactive.

### TC-018: Wire Compatibility Smoke Test

- **Requirement**: REQ-015, REQ-021, REQ-022
- **Type**: Integration
- **Priority**: Medium
- **Preconditions**:
  - Existing chat API transport tests or a controlled fetch mock are available.
- **Steps**:
  1. Execute a normal chat request without plugin elicits.
  2. Execute a plugin elicit request/response continuation.
  3. Compare request/response shapes with existing expected schema.
- **Expected Result**:
  - No new required HTTP fields are introduced.
  - Existing durable stream event shapes remain accepted.
  - Session identity and retention behavior are unchanged.

## 4. Negative Test Cases

### TC-N01: Unknown Local Emission Response Is Ignored Safely

- **Requirement**: REQ-019
- **Type**: Unit
- **Priority**: High
- **Purpose**: Verify reducer safety for missing call IDs and emission IDs.
- **Steps**:
  1. Create local emission state with one known call/emission.
  2. Dispatch `tool_emission_response` for unknown `callId`.
  3. Dispatch `tool_emission_response` for known `callId` but unknown `emissionId`.
  4. Inspect state and thrown errors.
- **Expected Result**:
  - No exception is thrown.
  - State remains unchanged for unknown IDs.
  - Known emissions remain intact.

### TC-N02: Duplicate onRespond Invocation Does Not Double Resume

- **Requirement**: REQ-003
- **Type**: Integration
- **Priority**: High
- **Purpose**: Verify double-click/race behavior.
- **Steps**:
  1. Capture a pending emission's callback.
  2. Invoke it twice synchronously with different payloads.
  3. Count handler resumes and `respondToElicit` calls.
- **Expected Result**:
  - At most one resume occurs.
  - At most one elicit response is sent.
  - The first accepted response wins.

### TC-N03: Error Cleanup Does Not Hide Tool Error

- **Requirement**: REQ-006, REQ-018
- **Type**: Unit / Integration
- **Priority**: High
- **Purpose**: Verify terminal error cleanup does not suppress error display.
- **Steps**:
  1. Create state with pending elicit tracking and a running tool-call part.
  2. Apply a terminal tool error event for the call.
  3. Render/derive messages.
- **Expected Result**:
  - Pending elicit tracking is removed.
  - The derived tool-call part remains in error state with the error message.
  - No completed or pending callback remains for that failed call.

### TC-N04: Responding to First Step Does Not Prematurely Clear Multi-Step Flow

- **Requirement**: REQ-007
- **Type**: Integration
- **Priority**: High
- **Purpose**: Guard against over-eager cleanup after first elicit response.
- **Steps**:
  1. Start a two-step plugin flow.
  2. Respond to the first elicit.
  3. Before terminal result, inspect pending elicit tracking and emitted UI.
- **Expected Result**:
  - The second elicit appears.
  - The call remains tracked as active/pending until terminal result.
  - The flow does not end after the first response.

### TC-N05: Duplicate Assistant Message IDs Are Not Appended

- **Requirement**: REQ-009, REQ-010, NFR-003
- **Type**: Unit
- **Priority**: High
- **Purpose**: Verify duplicate assistant IDs cannot create duplicate React keys.
- **Steps**:
  1. Reduce an empty assistant-final message with ID `assistant:final:call1`.
  2. Reduce a non-empty assistant-final message with the same ID.
  3. Derive messages for rendering.
- **Expected Result**:
  - Only one message with that ID is present.
  - The derived render list has unique message IDs.
  - The latest non-empty content is preserved.

### TC-N06: Static Search Rejects Debug Markers and Sensitive Logs

- **Requirement**: REQ-016, REQ-020
- **Type**: Static
- **Priority**: High
- **Purpose**: Ensure diagnostic code is not shipped.
- **Steps**:
  1. Run `rg "\[book-flight-debug\]"` from repository root.
  2. Inspect any new `console.log`, `console.warn`, or logger calls in touched files.
  3. Confirm no logging prints response payloads, model context, session IDs, or elicit payloads by default.
- **Expected Result**:
  - No diagnostic markers are found.
  - No new sensitive default logging exists.

### TC-N07: Historical Completed Controls Cannot Submit New Responses

- **Requirement**: REQ-014, REQ-023
- **Type**: E2E / Integration
- **Priority**: Medium
- **Purpose**: Verify stale historical UI cannot capture current-flow interactions.
- **Steps**:
  1. Complete a first booking flow.
  2. Before starting the second flow, query historical FlightList and SeatPicker controls.
  3. Attempt to click historical selected/confirm controls if present.
  4. Start the second flow and ensure current controls work.
- **Expected Result**:
  - Historical controls are absent, disabled, or non-interactive.
  - Clicking historical UI does not send a new elicit response.
  - The second flow uses fresh active controls.

## 5. Coverage Matrix

| Requirement | Test Cases | Priority | Status |
|-------------|------------|----------|--------|
| REQ-001 | TC-001 | High | Planned |
| REQ-002 | TC-002 | High | Planned |
| REQ-003 | TC-003, TC-N02 | High | Planned |
| REQ-004 | TC-001, TC-004 | High | Planned |
| REQ-005 | TC-005, TC-016 | High | Planned |
| REQ-006 | TC-006, TC-N03 | High | Planned |
| REQ-007 | TC-007, TC-N04 | High | Planned |
| REQ-008 | TC-008, TC-016 | High | Planned |
| REQ-009 | TC-009, TC-N05 | High | Planned |
| REQ-010 | TC-010, TC-N05 | High | Planned |
| REQ-011 | TC-010, TC-011 | High | Planned |
| REQ-012 | TC-012 | High | Planned |
| REQ-013 | TC-012 | High | Planned |
| REQ-014 | TC-004, TC-012, TC-N07 | High | Planned |
| REQ-015 | TC-014, TC-018 | High | Planned |
| REQ-016 | TC-015, TC-N06 | High | Planned |
| REQ-017 | TC-013, TC-017 | High | Planned |
| REQ-018 | TC-006, TC-N03 | High | Planned |
| REQ-019 | TC-N01 | High | Planned |
| REQ-020 | TC-015, TC-N06 | High | Planned |
| REQ-021 | TC-011, TC-018 | High | Planned |
| REQ-022 | TC-014, TC-018 | High | Planned |
| REQ-023 | TC-004, TC-012, TC-N07 | High | Planned |
| NFR-001 | TC-001, TC-014 | Medium | Planned |
| NFR-002 | TC-005, TC-016 | Medium | Planned |
| NFR-003 | TC-009, TC-010, TC-015, TC-N05 | High | Planned |

## 6. Test Data

- Plugin call IDs:
  - `callA`, `callB`, `callX`, `callY` for unit/integration fixtures.
  - Real provider call IDs from e2e runs for `book_flight`.
- Elicit IDs:
  - `callA:req:1`, `callA:req:2`, `callB:req:2`.
- Emission IDs:
  - `callA:req:2-em-1`, `callB:req:2-em-1`.
- Book flight e2e inputs:
  - Outbound request: `Use the book_flight tool to book an outbound flight from Los Angeles to New York.`
  - Return request: `Great, now use the book_flight tool again to book the return flight from New York to Los Angeles.`
  - Outbound seat: `2A`.
  - Return seat: `3C`.
- Confirmation matching pattern:
  - `/ticket|confirmed|booked|confirmation|TKT-/i`.
- Static search markers:
  - `[book-flight-debug]`.
  - `Encountered two children with the same key` in captured browser console output.

## 7. Environment Requirements

- Node/pnpm environment matching the repository setup.
- Yo-chat dev server running for e2e tests, typically at `http://localhost:8000/`.
- Local LLM/tool-calling service required by existing yo-chat e2e tests.
- Browser dependencies installed for Playwright.
- Relevant packages installed through `pnpm install`.
- Test commands should be run from repository root unless command specifies `-C`.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| E2E depends on local LLM/tool-calling behavior | Flaky or slow repeated-flow verification | Keep deterministic unit/integration tests for lifecycle requirements; use robust e2e locators and generous timeout already in the spec |
| Emission completion dispatch order causes handler to resume before UI updates | Confirm button may remain briefly interactive or allow double-click | Include idempotence tests and assert local state completion after direct callback |
| Elicit cleanup emitted too early | Multi-step flows such as flight → seat break | TC-007 and TC-N04 explicitly verify no cleanup before terminal result |
| Assistant message dedupe drops finalized parts or final content | Chat transcript loses rendered final answer | TC-009 and TC-010 verify latest content and finalized parts preservation |
| Error cleanup hides errors | Users lose visibility into failed tools | TC-006 and TC-N03 require both cleanup and error rendering |
| Framework-level change affects other plugins | Tic-tac-toe/play-ttt regressions | TC-017 covers representative non-flight plugin flows |
| Debug instrumentation accidentally remains | Noisy logs or sensitive state exposure | TC-015 and TC-N06 require static search and console checks |

## 9. Acceptance Test Commands

At minimum, after implementation run:

```bash
pnpm -C packages/framework test
pnpm -C apps/yo-chat test
pnpm -C apps/yo-chat test:e2e --grep "can complete outbound and return bookings"
```

Before final session completion, follow project guidance for touched code quality gates and all e2e tests in all applications as feasible/required by the maintainer.
