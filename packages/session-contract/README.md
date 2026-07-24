# @sweatpants/session-contract

ProgramDriver durable runtime and journal contracts for Sweatpants.

This package provides:

- pinned crank-native program manifests and pure generator programs
- `ProgramDriver` attachment/step/shutdown ports
- one append-only `DurableSemanticRecord` journal authority
- in-memory journal authority for development and tests
- capability-authenticated effect and elicitation resolution
- Standard Schema validator registries and portable schema descriptors
- deterministic child programs, cancellation, replay, and recovery
- shared in-memory/Redis journal-authority conformance fixtures

## Durable tool authoring

Application authors normally use the Zod-first builders from `@sweatpants/core`:

```ts
import { createDurableTool, defineEffect } from "@sweatpants/core";
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

Libraries can define typed durable context extensions through `@sweatpants/core` and tools declare
them explicitly with `.uses()`:

```ts
const data = defineDurableContextExtension({
    name: "example-data",
    effects: { readValue, writeValue },
});

const tool = createDurableTool("example")
    // description, identity, and parameters omitted
    .uses({ data })
    .execute(function* (input, ctx) {
        const value = yield* ctx.data.readValue(input);
        const sameValue = yield* ctx.use(data).readValue(input);
        const recordedAt = yield* ctx.record("observed-at", function* () {
            return new Date().toISOString();
        });
        return { value, sameValue, recordedAt };
    });
```

`ctx.effect()` invokes a runtime-installed, placement-neutral effect. `ctx.record()` instead keeps
its implementation with the pinned program artifact and records the accepted result; a resolved
recording replays without running its closure again. Recording closures cannot schedule nested
durable operations.

### Retry safety and model sampling

`repeatable` means an unresolved attempt may run again and return a different value; it is not an
idempotency or exactly-once guarantee. New `model.sample` authoring uses repeatable wire version 2.
If a sample becomes indeterminate before its outcome is committed, retrying may produce a different
response and may incur duplicate provider cost. Exact `model.sample@1` registration remains available
only to replay already-pinned programs that declared pull-ID idempotency.

## Journal authority

Use `createInMemoryDurableJournalAuthority` for development and
`createRedisDurableJournalAuthority` from `@sweatpants/crank-store-redis` for shared persistence.
Both implementations execute the same authority conformance corpus.
