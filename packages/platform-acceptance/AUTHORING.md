# Framework Acceptance Authoring

## Default: causal scenario scripts

Framework acceptance tests use `withTestScenario` and Effection generators. A scenario reads in causal order: perform an action, then consume and control the consequence.

```ts
await withTestScenario(
  {
    binding,
    modelId: ACCEPTANCE_MODEL_ID,
    createApplication: createAcceptanceApplication,
  },
  function* (s) {
    const conversation = s.conversation({ tools: [bookingTool] });
    const turn = yield* conversation.send("Book NYC to LAX");

    const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
    yield* request.respond.toolCalls([
      { id: "call-1", name: "book_flight", arguments: { from: "NYC", to: "LAX" } },
    ]);

    const flight = yield* turn.elicit("pickFlight");
    yield* flight.accept({ flightId: "FL001" });

    const final = yield* s.model.request();
    yield* final.respond.text("Booked.");
    expect((yield* turn.settled()).text).toBe("Booked.");
  },
);
```

Do not pre-arm promises in ordinary acceptance scenarios. Provider requests and elicitations are buffered, so asking for a consequence after its cause is race-free. Request expectations validate the oldest request; they do not search past or reorder buffered requests.

## Vocabulary

- `s.conversation(options)` creates or reuses a durable conversation.
- `yield* conversation.send(message)` returns a first-class turn.
- `yield* s.model.request(expectation?)` consumes the next provider request.
- `yield* request.respond.*` controls the provider response.
- `yield* turn.elicit(key)` consumes a named elicitation.
- `yield* turn.textDelta(expectation)` observes streamed text.
- `yield* turn.settled()` requires successful completion.
- `yield* turn.failure(expectation?)` requires failure and optionally validates it.
- `yield* turn.cancel()` waits for server-side cancellation.
- `yield* conversation.supersede(message)` replaces an active turn.
- `yield* conversation.reopen()` creates a fresh client session with the same durable ID.
- `s.streams` exposes causal response-stream open/event/checkpoint/reconnect operations.

## Real concurrency

Use Effection `spawn` only when two operations must genuinely overlap. Keep the causal relationship visible:

```ts
const providerAborted = yield * spawn(() => nested.respond.awaitAbort());
yield * turn.cancel();
yield * providerAborted;
yield * turn.failure();
```

Multiple conversations may share one scenario. Script their request arrival order explicitly unless the behavior under test is a true race.

## Advanced promise-barrier escape hatch

`withTestRig`, `rig.model.expectRequest`, and the raw chat handles remain available for interactions that cannot be expressed clearly as a causal script. Their use in framework acceptance requires a comment explaining why scenario operations are insufficient. Set `unmatchedRequests: "poison"` when the test specifically requires every provider expectation to be armed before arrival.

The low-level API is an escape hatch, not a second default style.

## Rules for new tests and feature specs

Future framework feature specifications and implementation plans should express acceptance examples as causal scenario scripts using the vocabulary above. New acceptance tests:

1. MUST use `withTestScenario` by default.
2. MUST read in cause-then-consequence order.
3. MUST synchronize on semantic operations, never sleeps, polling, manual crank calls, or assumed scheduler counts.
4. SHOULD run the same scenario body against both `in-process` and `http` bindings. Boundary-specific exceptions need a written reason.
5. MUST keep model request expectations structural and explicit; the rig does not simulate model intelligence.
6. MUST settle or intentionally fail every turn and answer, abort, or otherwise terminate every consumed provider request.
7. SHOULD use local variables for multi-step handles rather than nested `yield*` expressions when names clarify the interaction.

When a proposed feature needs a new kind of interaction, extend the scenario vocabulary first instead of reintroducing ad hoc deferred queues in the acceptance test.
