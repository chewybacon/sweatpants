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

## Journal authority

Use `createInMemoryDurableJournalAuthority` for development and
`createRedisDurableJournalAuthority` from `@sweatpants/crank-store-redis` for shared persistence.
Both implementations execute the same authority conformance corpus.
