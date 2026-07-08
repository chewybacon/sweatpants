# Phase 3 Handoff Prompt

We are in repo:

```txt
/Users/rrauh/lecode/glg/vibes/agentcore/sweatpants
```

Read first:

```txt
.pi/specs/test-pass-work-order.md
```

The goal is **not** to rewrite the browser/MCP outer shells. The goal is:

> Make `session-contract` the only agent execution core while preserving existing turn-based browser chat and MCP protocol behavior.

Critical constraints:

1. **Do not turn chat into a permanent live `/events` subscription.**
2. **Do not change e2e waits from `networkidle` to `load`.**
3. **Do not fake assistant/model responses to satisfy tests.**
4. **Do not hardcode product/test-specific behavior.**
5. **Do not bypass the model after tools complete.**
6. **Do not delete outer shell modules like `create-session.ts`, `stream-chat.ts`, `event-mapper.ts`, `durable-history.ts`, MCP handler, etc.**
7. It is okay that `chat-engine.ts` is deleted only if the session-contract adapter truly replaces the execution core and tests pass.

Current state / recent work:

- Phase 1 and Phase 2 were mostly completed:
  - `session-contract` core hardening tests added.
  - `FoldSessionHost` interface added.
  - `respondIfPending(...)` added as a first-class lifecycle-race API.
  - fold driver no longer depends on `InMemorySession`.
  - fold driver supports canonical `{ calls: [...] }` only.
  - legacy `{ call: ... }` support was removed.
- Phase 3 is in progress:
  - old `packages/framework/src/handler/durable/chat-engine.ts` was deleted.
  - durable handler now imports/uses:
    ```ts
    createSessionContractChatEngine
    ```
    from:
    ```txt
    packages/framework/src/handler/durable/session-contract-adapter.ts
    ```
  - `createChatEngine` export was removed from framework server/durable index.
  - type names were changed to:
    ```ts
    SessionContractChatEngineParams
    SessionContractChatEngine
    ```

Validation that was passing before the latest e2e issue:

```bash
pnpm --filter @sweatpants/session-contract test -- --run
pnpm --filter @sweatpants/framework test -- --run
npx tsc --noEmit -p packages/session-contract/tsconfig.json
npx tsc --noEmit -p packages/framework/tsconfig.json
npx tsc --noEmit -p packages/tool-runtime-local/tsconfig.json
pnpm --filter @sweatpants/session-contract build
pnpm --filter @sweatpants/framework build
```

Important files changed/added:

```txt
packages/session-contract/src/types.ts
packages/session-contract/src/index.ts
packages/session-contract/src/in-memory-session.ts
packages/session-contract/src/fold-driver.ts
packages/session-contract/src/create-agent.ts
packages/session-contract/src/loopback.ts
packages/session-contract/src/__tests__/core-hardening.test.ts
packages/session-contract/src/__tests__/fold-driver.test.ts
packages/session-contract/src/__tests__/fold-driver-phase2.test.ts

packages/framework/src/handler/durable/session-contract-adapter.ts
packages/framework/src/handler/durable/handler.ts
packages/framework/src/handler/durable/index.ts
packages/framework/src/handler/durable/types.ts
packages/framework/src/server/index.ts
packages/framework/src/handler/durable/__tests__/session-contract-adapter.test.ts
packages/framework/src/handler/durable/chat-engine.ts  # deleted

packages/tool-runtime-local/src/session-registry.ts
```

Important recent fix:

- `packages/tool-runtime-local/src/session-registry.ts`
  - changed the cross-scope session handoff from unbuffered `createChannel` to buffered `createQueue`.
  - Reason: the unbuffered channel deadlocked when `ToolSessionRegistry.create()` spawned a detached background task that sent the session before the caller subscribed.
  - This fixed the initial plugin elicit hang.

Current e2e status:

- Focused book-flight e2e now reaches:
  - FlightList appears ✅
  - SeatPicker appears ✅
  - seat can be confirmed ✅
  - final confirmation hangs/fails ❌

Command:

```bash
pnpm --filter @sweatpants/session-contract build
pnpm --filter @sweatpants/framework build
pnpm copilot:auth:refresh && pnpm copilot:auth:sync
lsof -ti :8000 | xargs kill -9 2>/dev/null || true
cd apps/yo-chat
timeout 360 npx playwright test --reporter=line e2e/book-flight-full.spec.ts
```

Observed failure:

- Test reaches “Step 5: Waiting for confirmation...”
- No ticket/confirmation appears.
- Page eventually resets/has no visible final assistant confirmation.
- This means the first two plugin elicit/resume turns work, but after final tool result the model is not being called/continued correctly.

Very important correction:

A bad synthetic assistant confirmation was previously added in:

```txt
packages/framework/src/handler/durable/session-contract-adapter.ts
```

It looked like:

```ts
const confirmation = assistantTextFromToolAnswer(answer);
if (confirmation) {
  emit TEXT_MESSAGE_START
  emit TEXT_MESSAGE_CONTENT
  emit TEXT_MESSAGE_END
}
```

and helper:

```ts
assistantTextFromToolAnswer(...)
```

This is wrong. Remove/revert it.

Why wrong:

- It fakes a model response.
- It hardcodes behavior to make book-flight pass.
- It bypasses the actual post-tool model continuation.
- The correct behavior is: final plugin result should answer the original fold call wait, the fold driver should append tool result to transcript, emit next sample wait, call model, and stream the model’s response.

The actual bug to debug:

After the final plugin result, `projectResumeResponses(...)` in:

```txt
packages/framework/src/handler/durable/session-contract-adapter.ts
```

currently projects a `TOOL_CALL_RESULT` event but likely does **not** resume/answer the original fold `call` wait. It probably treats resume as a standalone projection instead of continuing the fold turn.

Investigate these questions:

1. Is the fold session used by `createSessionContractChatEngine(...)` persisted across HTTP turns?
   - It currently appears to create an in-memory session inside each stream call:
     ```ts
     const session = yield* createInMemorySession({ sessionId, mode: "fold" })
     ```
   - If this is per-request and not backed by a shared/durable store, the original pending `call` wait is gone on resume.
   - That would explain why resume only emits projection events and does not continue the fold.

2. What is the adapter’s session id?
   - It likely uses:
     ```ts
     params.agUiRun.runId || params.agUiRun.threadId
     ```
   - But durable chat handler may create a new run id per request.
   - If so, the fold session key changes across elicit resume turns.
   - It probably should key by durable conversation/thread/session id, not per-run id, if it needs to resume the fold.

3. What exactly does the browser send on elicit response?
   - Check `elicitResponses` payload in POST body.
   - Confirm fields:
     ```txt
     sessionId
     callId
     toolName
     elicitId
     result
     ref?
     ```
   - For public AG-UI interrupts, `ref` may not be present because public metadata sanitization strips it.

4. How should plugin resume be integrated?
   - Current code path:
     ```ts
     projectResumeResponses(params, session)
       pluginSessionManager.get(...)
       respondToElicit(...)
       nextEvent()
       emit TOOL_CALL_RESULT or next elicit wait
     ```
   - That is only projecting.
   - Correct behavior needs to connect final plugin result back to the fold driver’s pending call wait.

5. If final plugin resume returns another elicit:
   - emit parent `wait(elicit)`
   - adapter emits `RUN_FINISHED interrupt`
   - stream closes
   - no infinite sleeps

6. If final plugin resume returns result:
   - answer original pending `call` wait
   - fold driver continues:
     ```txt
     transcript += tool result
     emit next wait(sample)
     call model
     stream model response
     checkpoint
     wait(message)
     close stream
     ```

Also important:

- We fixed an earlier bad pattern:
  - no infinite sleep while waiting for elicit reply inside resolver.
  - `tool_awaiting_elicit` is now a non-fatal parked outcome in fold driver.
- Keep that. Do not reintroduce `while(true) sleep(...)` to park.

Likely next implementation direction:

1. Remove synthetic assistant response helper/projection.
2. Make `createSessionContractChatEngine` use a durable/shared session-contract store across turns.
   - Key it by stable thread/conversation id, not run id.
   - Possibly pass the durable session id from handler into `SessionContractChatEngineParams`.
3. On initial tool call:
   - fold emits `wait(call)`
   - resolver/plugin manager emits parent `wait(elicit)`
   - resolver returns `tool_awaiting_elicit`
   - fold driver stops.
   - Adapter emits `RUN_FINISHED interrupt`.
4. On resume:
   - restore same fold session.
   - resume plugin session.
   - if plugin returns result, respond to pending `call` wait in the fold session with that result.
   - let fold driver continue and produce a model sample.
5. Add/adjust unit tests in:
   ```txt
   packages/framework/src/handler/durable/__tests__/session-contract-adapter.test.ts
   ```
   to specifically assert:
   - first plugin elicit emits interrupt and bounded stream closes.
   - resume final plugin result causes another model sample, not synthetic assistant text.
6. Then rerun:
   ```bash
   pnpm --filter @sweatpants/session-contract test -- --run
   pnpm --filter @sweatpants/framework test -- --run
   npx tsc --noEmit -p packages/session-contract/tsconfig.json
   npx tsc --noEmit -p packages/framework/tsconfig.json
   npx tsc --noEmit -p packages/tool-runtime-local/tsconfig.json
   pnpm --filter @sweatpants/session-contract build
   pnpm --filter @sweatpants/framework build
   ```
7. Then focused e2e:
   ```bash
   pnpm copilot:auth:refresh && pnpm copilot:auth:sync
   lsof -ti :8000 | xargs kill -9 2>/dev/null || true
   cd apps/yo-chat
   timeout 360 npx playwright test --reporter=line e2e/book-flight-full.spec.ts
   ```
8. Only then run larger e2e.

Potential temporary debug technique:

- You can add a temporary Playwright spec that POSTs to `/api/chat` and prints NDJSON frames, but remove it before final.
- Previous debug proved that after the session-registry queue fix, first response contains:
  ```txt
  TOOL_CALL_START
  TOOL_CALL_ARGS
  TOOL_CALL_END
  RUN_FINISHED interrupt
  ```
  with `x-elicit-context` containing flights. So first elicit is now okay.

Current public interrupt projection details:

- `RUN_FINISHED.outcome.interrupts[0]` includes:
  ```txt
  id = elicitId
  toolCallId = callId
  metadata:
    sweatpants/toolName
    sweatpants/key
  responseSchema with x-elicit-context
  message with x-elicit-context boundary
  ```
- Public metadata should not leak private refs.

Do not continue if you are tempted to make tests pass by:
- hardcoding ticket text,
- generating assistant text from tool results,
- changing e2e waits,
- adding sleep loops,
- bypassing the fold/model call.

The model must be called correctly after final tool result.
