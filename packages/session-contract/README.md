# @sweatpants/session-contract

Durable replay-crank runtime for lazy pull-generator programs.

## Authoring

```ts
import { effect, elicit, call, all, emit, record } from "@sweatpants/session-contract";

const turn = function* (input) {
    const answer = yield* effect("model.sample", input);
    const approved = yield* elicit("approval", {
        key: "approval",
        message: "Continue?",
        responseSchema: { type: "boolean" },
    });
    return { answer, approved };
};
```

Calling a program factory must be lazy. Network, model, tool, storage, clock,
randomness, and public output work belongs behind a pull. `record()` captures
nondeterministic values used by later control flow or pull inputs.

Effects and record producers are **at least once** until `pull_resolved` is
acknowledged. Every handler receives the stable `pullId`; downstream writes
must be naturally idempotent or deduplicated with that key. Do not use
`record()` for an unprotected non-idempotent write.

Tools are registered as child program factories and invoked with `invoke()` or
`call()`. `all()` allocates the complete child identity range before child work
starts and returns values in source order.

## Lifecycle

External clients append idempotent `send`, `respond`, `cancel_turn`, and
`close_session` commands. A host calls `runtime.activate(sessionId)` for a
durably runnable session. An activation claims an epoch-fenced lease, creates
fresh generators, and replays the active turn. It ends closed, fenced, or
parked. Parking atomically releases ownership and retains no generator, task,
timer, or process.

```ts
const store = createInMemoryCrankStore();
const runtime = createCrankRuntime({
    store,
    rootProgram: turn,
    programVersion: "build-123",
    effects: { "model.sample": sampleHandler },
});
const session = createCrankSession(store, "conversation-1");
```

`createInMemoryCrankStore()` uses the same command, claim, fencing,
expected-head append, and park/release interfaces required from production
stores. It never preserves generator continuity.

## Journal and public events

The private append-only journal records commands, turn/task opening, pull
request/resolution, attempts, durable emissions, task closure, and session
closure. Pull replay identity includes task, pull index, symbolic target, and
an RFC 8785/SHA-256 input fingerprint.

Clients observe only `CrankSession.events()`, a redacted durable projection with
cursor semantics. Raw prompts, hashes, versions, owner epochs, leases, and
private error details are not part of the client protocol.
