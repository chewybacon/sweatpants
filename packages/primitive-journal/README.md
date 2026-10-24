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

## Recovering an explicit failed Outcome

Middleware can recover a handler's application failure with native host work:

```ts
import { call, type Operation } from "effection";
import {
  failure,
  success,
  type HandlerMiddleware,
  type IterableOperation,
  type Json,
  type Outcome,
} from "@sweatpants/primitive-journal";
import { type RecordRequest } from "@sweatpants/primitive-journal/example";

type Yielded = Operation<unknown> extends IterableOperation<unknown, infer Y> ? Y : never;
type Layer = HandlerMiddleware<RecordRequest, Yielded, Outcome<Json, Json>>;
const recover: Layer = function* ([request], next) {
  const outcome = yield* next(request);
  if (outcome.ok) {
    return outcome;
  }
  const fallback = yield* call(() => Promise.resolve("fallback"));
  return success(fallback);
};
const outer: Layer = function* ([request], next) {
  const outcome = yield* next(request);
  return outcome.ok ? success(`outer:${outcome.value}`) : outcome;
};
// With the journal above, the handler's failure becomes "outer:fallback".
const execute = createSequenceRunner(
  journal,
  function* () {
    return failure("unavailable");
  },
  [outer, recover],
);
```

The first layer is outermost. Only the final composed Outcome is accepted;
neither the base failure nor the intermediate fallback is a separate exchange.
Middleware does not run for accepted replay, though guest code runs again.
A middleware reply or trace event is not a durable acknowledgement. Native work
inside middleware shares the enclosing request's uncertainty and retry boundary:
loss before acceptance can repeat that work under repeatable safety, or block an
unsafe request. The fallback is not separately journaled, and this does not make
external I/O exactly once.

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

## Native guests and external answers

An operation-backed `Guest` owns a fresh native cursor: `start` runs once,
`resume` requires its current suspension, and idempotent `close` releases compute
without logical cancellation. `GuestWork` acquires one such cursor per activation.
The adapter translates native boundaries into structural `Turn` values; the
runtime-neutral engine does not import the native runtime.

```ts
// Run inside the host's native operation. work acquires a fresh Guest cursor.
const activation = yield * activateJournal(work, journal);
// activateJournal has closed compute before returning this durable occurrence.
if (activation.state === "parked") {
  const requestId = activation.request.id;
  // Later, with no native cursor alive, reopen the same local Identity/journal:
  journal.acceptRequest(requestId, success(answer));
  // A new activateJournal(work, journal) reconstructs accepted replies.
}
```

`PendingJournal` adds `park`, `readRequests`, and `acceptRequest` to the immediate
Journal contract. SQLite persists stable occurrences separately from attempts;
waiting for an external answer does not represent an uncertain effect attempt.
Answer acceptance commits the ordinary exchange before returning its persisted
Outcome. The same answer is idempotent even after later requests or completion;
a conflicting answer rejects. Reconstruction verifies every request and terminal
result, runs native deterministic computation again, and dispatches no handler.

Request IDs correlate the full pinned Identity, sequence and JSON request. They
are not authorization tokens: the selected local journal/Identity is the trust
boundary. This remains serialized single-local-writer execution. Normal compiled
Lua return cleanup can be reconstructed; durable cancellation, arbitrary native
JS finalizers, distributed ownership and exactly-once I/O are not promised.
