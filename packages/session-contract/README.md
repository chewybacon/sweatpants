# @sweatpants/session-contract

ProgramDriver durable runtime and journal contracts for Sweatpants.

This package provides:

- pinned crank-native program manifests and scope-owned Effection program Operations
- `ProgramDriver` attachment/step/shutdown ports
- one append-only `DurableSemanticRecord` journal authority
- in-memory journal authority for development and tests
- capability-authenticated effect and elicitation resolution
- Standard Schema validator registries and portable schema descriptors
- deterministic child programs, cancellation, replay, and recovery
- shared in-memory/Redis journal-authority conformance fixtures

## Durable tool authoring

Application authors normally use the Zod-first builders from `@sweatpants/agent-sdk`:

```ts
import { createDurableTool, defineEffect } from "@sweatpants/agent-sdk";
import { z } from "zod";

const lookup = defineEffect({
    name: "example.lookup",
    version: "1",
    input: z.object({ id: z.string() }),
    output: z.object({ value: z.string() }),
    retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export const example = createDurableTool("example")
    .description("Durable example")
    .identity({ version: "1", digest: "0".repeat(64) })
    .parameters(z.object({ id: z.string() }))
    .output(z.string())
    .effects({ [lookup.name]: lookup })
    .execute(function* ({ id }, context) {
        return (yield* context.effect(lookup, { id })).value;
    });
```

Runtime Standard Schema validators remain process-local. Journals and transports contain only
canonical JSON values, portable schema descriptors, and exact semantic digests.

### Context extensions and inline recording

Libraries can define typed durable context extensions through `@sweatpants/agent-sdk` and tools declare
them explicitly with `.uses()`:

```ts
const Data = createApi("example-data", {
    *readValue(input: { key: string }) {
        /* ordinary provider */
    },
    *writeValue(input: { key: string; value: string }, execution: { operationId: string }) {
        /* ordinary provider */
    },
});
const data = defineDurableContextExtension({
    name: "example-data",
    api: Data.operations,
});

const tool = createDurableTool("example")
    // description, identity, and parameters omitted
    .uses({ data })
    .execute(function* (input, ctx) {
        // Safe observation: it may run again on every attachment reconstruction.
        const value = yield* ctx.data.readValue(input);
        const sameValue = yield* ctx.use(data).readValue(input);

        // Unsafe/costly mutations must not be ordinary unrecorded calls.
        const written = yield* ctx.record(
            { retrySafety: { mode: "idempotent", mechanism: "pull_id_key" } },
            function* ({ pullId }) {
                return yield* ctx.data.writeValue(input, { operationId: pullId });
            },
        );
        return { value, sameValue, written };
    });
```

Durable tool bodies are ordinary Effection Operations. Calls such as `yield* Files.read(path)` run
normally and run again once per attachment reconstruction, including park/resume and recovery.
Frequent parking can therefore repeat observations and any unrecorded cost. Reads and other safe
observations are appropriate ordinary calls. Costly calls and external mutations are unsafe as
ordinary calls; wrap repeatable work or pull-ID-idempotent mutations in `ctx.record()`, and declare
unsafe indeterminate policy when duplication cannot be tolerated. `ctx.effect()` invokes a
runtime-installed, placement-neutral durable effect. `ctx.record()` keeps its implementation with
the pinned program artifact and records the accepted result; a resolved recording replays without
running its closure again. Recording closures cannot schedule nested durable operations. If an
ordinary operation fails while reconstructing already-accepted history, the runtime fences the
unreconstructable task, shuts down its scope, and propagates the original safe application error.

### Retry safety and model sampling

`repeatable` means an unresolved attempt may run again and return a different value; it is not an
idempotency or exactly-once guarantee. The single `model.sample` contract is repeatable wire version 2. If a sample becomes indeterminate before its outcome is committed, retrying may produce a
different response and may incur duplicate provider cost. There is no legacy sampling registration
or replay compatibility path.

## Journal authority

Use `createInMemoryDurableJournalAuthority` for development and
`createRedisDurableJournalAuthority` from `@sweatpants/journal-authority-redis` for shared persistence.
Both implementations execute the same authority conformance corpus.
