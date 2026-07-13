# @sweatpants/session-contract

Durable replay-crank runtime for lazy pull-generator programs. The package now
contains two explicitly classified surfaces:

- `createDurableTool` and the crank-native driver/authority APIs implement the
  strict durable contract.
- The original `ProgramFactory` helpers remain a compatibility surface while
  existing callers migrate; they must not be advertised as crank-native.

## Crank-native authoring

```ts
const echo = defineDurableEffect({
    name: "echo",
    version: "1",
    inputSchema: { type: "string" },
    outputSchema: { type: "string" },
    retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const tool = createDurableTool(
    {
        programId: "example.echo",
        version: "1.0.0",
        digest: "<lowercase sha256 bundle digest>",
        inputSchema: { type: "string" },
        outputSchema: { type: "string" },
        elicits: {},
        effects: { echo },
        capabilities: {
            durableEmissions: true,
            structuredChildren: false,
            replay: "strict",
        },
    },
    function* (input, context) {
        yield* context.emit("progress", { stage: "starting" });
        return yield* context.effect("echo", "1", input, {
            audience: "host-effects",
        });
    },
);
```

The durable program context also exposes journaled elicitation, durable waits,
`invoke`, `all`, `race`, and structured `spawn`/`join`. Construction is lazy;
program code receives no concrete effect handler or ambient credential.

`ProgramPeer`, `JournalAuthority`, `DurableEffects`, and `ProgramRuntime` are
native `effection/experimental` `createApi` values. Install driver, authority,
and effect registries through their scope-local contexts. The in-memory
journal authority provides reserve-before-dispatch, HMAC pull capabilities,
audience checks, duplicate receipts, conflict detection, detached/revoked
attempt state, unsafe indeterminacy, timer-free durable waits, emissions, and
completion validation.

MCP helpers expose `works.earendil/durable-effects-v1`, honest
`opaque`/`server_task`/`crank_native` classification, MRTR authorize/commit
shapes, and bounded caller-bound encrypted `requestState` storage. Source graph
scanning is exported as a **guardrail only**; runtime evaluator isolation remains
the security boundary.

## Compatibility authoring

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
