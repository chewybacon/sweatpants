# `@sweatpants/test-rig`

Private deterministic test infrastructure for Sweatpants framework acceptance.

## Start here

Acceptance authors should normally read:

1. [`../platform-acceptance/AUTHORING.md`](../platform-acceptance/AUTHORING.md)
2. [`src/scenario.ts`](./src/scenario.ts)
3. A causal example such as [`../platform-acceptance/src/history.acceptance.test.ts`](../platform-acceptance/src/history.acceptance.test.ts)

Use `withTestScenario`; do not begin with the low-level promise barriers.

## Mental model

A scenario controls both external actors around the framework under test:

```text
scenario user  -> real chat client/session -> real handler/runtime -> simulated model API
scenario user  <- elicitations/transcript  <- real handler/runtime <- scenario model responses
```

The script performs a cause and then consumes its consequence:

```ts
const turn = yield * conversation.send("hello");
const request = yield * s.model.request();
yield * request.respond.text("hi");
const transcript = yield * turn.settled();
```

This is race-free because scenario mode buffers model requests and elicitations until the script consumes them.

## Package map

- `src/scenario.ts` — primary authoring API. Adapts low-level promises into causal Effection operations.
- `src/index.ts` — owns complete rig lifecycle: simulator, application, binding, conversation runtime, poisoning, verification, timeouts, and cleanup.
- `src/model.ts` — Simulacrum/OpenAI Responses boundary. Captures real HTTP provider requests and emits parser-compatible SSE responses. Scenario requests use a strict FIFO arrival buffer.
- `src/chat.ts` — low-level conversation, turn, delta, authoritative snapshot, elicitation, cancellation, refresh, and transcript barriers over the real chat client.
- `src/transport.ts` — low-level response-stream open/checkpoint/disconnect/reconnect handle.
- `src/history.ts` — canonical normalization of OpenAI Responses input for assertions.

## Two authoring levels

### Scenario API (default)

`withTestScenario` is the normal acceptance-test surface. It always enables buffered provider arrivals and runs the generator script in an Effection scope.

### Promise barriers (advanced escape hatch)

`withTestRig`, `rig.model.expectRequest`, and raw chat/transport handles remain available for unusual interactions. Low-level `withTestRig` retains fail-fast unmatched-request poisoning by default. Set `unmatchedRequests: "buffer"` only when intentionally mixing the low-level API with causal consumption.

Framework acceptance use of the escape hatch requires a `scenario-escape-hatch:` rationale as documented in `AUTHORING.md`.

## Invariants

- Provider requests are consumed FIFO; expectations validate the oldest arrival and never search past it.
- `ScenarioContext.agui.frames()` retains raw observed AG-UI frames (including LSNs) for replay/inspector assertions; `events()` remains the live-run conformance view.
- Every consumed provider request must be answered, failed, disconnected, or aborted.
- Every turn must settle, fail, be cancelled, or be superseded.
- Successful rig cleanup verifies no requests, expectations, turns, or semantic barriers remain.
- The first failure poisons the rig; cleanup diagnostics never replace that primary failure.
- Tests synchronize on semantic events, never sleeps, polling, or manual workflow host cranks.
