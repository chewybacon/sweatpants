# Execution vocabulary

These names describe the current source during the framework rewrite. They do not
imply that every retained adapter implements the same capabilities.

## Computation and interpretation

- **Operation<T, Y>** is an iterable computation that yields `Y` and returns `T`.
  It does not itself select a scheduler, create a scope or persist anything.
  Foundation re-exports this contract as `IterableOperation`.
- **Work<T, Y>** is a function that produces an Operation. Calling it creates the
  computation; advancing the iterator executes its body.
- **Handler<Request, Y, Reply>** interprets a request using the host's yielded
  protocol and returns a reply. Journal handlers return `Outcome` data.
- **Outcome<Value, Error>** is `{ ok: true, value }` or `{ ok: false, error }`.
  A returned failure is distinct from a thrown defect or lost transport.
- **Composition<Y>** supplies scoped API/context bindings, middleware and cleanup.
  Plain `yield*` composes operations without creating another scope.
- **Runtime<Y>** runs operations using a particular native protocol. Its
  `RuntimeExecution.result` settles after owned work and cleanup finish;
  `cancel()` requests native cancellation and waits for cleanup.

The meaning of the yield channel depends on the layer:

```text
Authored iterator tool: yields JournalRequest; returns its inferred Result.
Guest method:           yields native scheduler/transport work; returns a Turn.
Journal handler:        yields native work; returns an Outcome.
```

Effection's `Operation` fixes a native scheduling protocol. It is not another name
for an authored iterator tool's domain requests. Effect adapters likewise need
matching native capabilities; switching a runtime does not translate operations.

## Advancement and lifetime

- **Guest<Result, Request, Y, Value, Error>** retains a live continuation. `start()`
  and `resume(outcome)` return a `Turn`; `close()` releases its resources.
- **GuestWork** acquires a Guest. Acquisition must not advance the authored body.
- **Turn** is either `{ kind: "suspended", request }` or
  `{ kind: "completed", value }`. Suspension alone is not durable acceptance.
- **Execution** is the richer foundation capability for correlated resume and
  logical cancellation. Its boundaries can also express failure and cancellation.
- **Checkpointing** adds capture of portable execution state. Ordinary JS generator
  Guests do not acquire this capability merely by using a journal.
- **Close/dispose** releases compute. **Logical cancellation** is an execution
  command and can itself suspend while cleanup requests are handled.

Guest and Execution share enforcement through the execution discipline. They are
not one oversized interface: checkpoint capture and correlated cancellation remain
explicit capabilities.

## Persistence

An **activation** acquires compute, replays accepted outcomes and advances until
completion or parking. **Parking** records a pending request and releases compute.
A subsequent activation reconstructs an iterator continuation through replay.
A Flowmode checkpoint can instead restore kernel state, under a host-owned journal
and recovery policy.

An **attempt** records that dispatch is starting. **Acceptance** records the
outcome that subsequent replay will use. With `retrySafety.mode: "unsafe"`, an
attempt lacking an accepted outcome causes `outcome_unknown`; it is not permission
to repeat the action. `repeatable` allows redispatch under that policy.

Sources: [composition contracts](../packages/standard-durability/src/contracts.ts),
[Guest and runtime contracts](../packages/foundation/src/computation.ts),
[execution discipline](../packages/foundation/src/execution-discipline.ts),
[journal activation](../packages/primitive-journal/src/activation.ts).
