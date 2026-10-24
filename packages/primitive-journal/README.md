# Primitive journal experiment

An independent port of effect-gh's iterator journal, hosted in Sweatpants. This
package has **no runtime dependencies**. It does not call journal authority,
ProgramDriver, the durable fold, or Sweatpants storage. The earlier experiment in
`journal-authority/src/experimental` remains a separate approach.

## Read from the bottom up

1. `src/primitives.ts`: Outcome, IterableOperation, Turn, Work, Handler and middleware
   (plus the shared runtime type contracts from effect-gh).
2. `src/iterator-turn.ts`, `src/handler-middleware.ts`: one synchronous pull and
   handler composition.
3. `src/contract.ts`: finite canonical JSON, identity, accepted exchanges, attempts,
   and the four-method Journal contract.
4. `src/driver.ts`: replay, handle, accept, feed. Live and historical replies use
   the same delivery function. Live execution retains the iterator.
5. `src/sqlite.ts`: an independent implementation with executions, exchanges and
   attempts tables. SQLite commits before returning an accepted reply.
6. `src/example.ts`: a typed `record()` operation and a small application adapter.

## Authoring and hosting

```ts
import { run } from "effection";
import { success } from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { createSequenceRunner } from "@sweatpants/primitive-journal/example";

const journal = new SqliteJournal("example.sqlite", {
  executionId: "example",
  program: { id: "sequence", version: "1", digest: "your-program-digest" },
  input: "hello",
});
try {
  const execute = createSequenceRunner(journal, function* (request) {
    // Native Effection operations can be delegated here for external I/O.
    return success(`hello:${request.key}`);
  });
  const result = await run(execute);
} finally {
  journal.close();
}
```

The guest uses `yield* record("same")` twice. Its yields describe requests; the
handler's yields belong to its host runtime. Middleware wraps the handler, so its
reply events precede journal acceptance. They are not durable acknowledgements.
Explicit failed Outcomes are accepted and thrown into the guest; host exceptions
leave an unresolved attempt. Guest code must be deterministic and keep external
side effects in handlers. Version/digest identity is supplied by the host.

## Evidence and scope

Run `pnpm --filter @sweatpants/acceptance test primitive-journal/independent.acceptance.test.ts`.
Artifacts are under ignored `.artifacts/primitive-journal/comparison-*`.
The reference subprocess uses the existing production ProgramDriver. The candidate
subprocess imports only this package and Effection. Comparison covers request
order, accepted outcomes, external call records and final result. Schemas,
capabilities, lease events and journal envelopes are deliberately not equivalent.

Candidate recovery checks kill the process after accepted exchanges, reopen the
same database, and prove accepted effects are not dispatched again. Separate
candidate-only checks cover lost repeatable results and blocked unsafe retries.
These do not claim equivalence to production recovery policy.

**One live local writer per execution.** A previous process must be gone before
restart. There are no mandates, fencing tokens, remote settlements, concurrent
owners, children, checkpoints, durable cancellation or resource cleanup protocol.
The afterAccepted callback is a trusted fault-injection seam and must not mutate
its argument. SQLite read validation scans history; this is not a performance
claim or a migration for existing databases.

Provenance: effect-gh `8591d9418d58a0557f165fcfdfd857626070d70e`,
`packages/core/src/primitives.ts` and `packages/lab/src/journal/*`, plus the small
iterator/middleware helpers. Imports and formatting were adapted to this repo;
the journal algorithm and schema were retained. Types are copied intentionally
while package ownership/publication remains experimental.
