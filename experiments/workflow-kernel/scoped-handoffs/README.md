# Scoped handoffs using existing execution contracts

This executable design experiment composes existing `Execution`,
`ExecutionState`, `ExecutionBoundary`, and `Exchange` types. It introduces no
production API or task lifecycle protocol. `handoff.mts` performs one exchange
and resumes its owning execution; the caller owns serialization and disposal.
A Flow can drive that same handoff repeatedly until its execution terminates.

The checks demonstrate:

- Distinct executions can invoke one exchange concurrently. Replies arriving in
  reverse order resume the right execution, even with equal execution-local
  suspension IDs. Both continuations observe one shared in-process cell.
- A pre-dispatch exchange failure does not advance the guest. A consumed
  suspension cannot be resumed again.
- Completed, failed and cancelled boundaries pass through unchanged, without
  issuing an exchange or advancing again. Capture is not required.

This is deliberately a hand-written execution fixture, not evidence that either
Wasm kernel implements shared task stacks. It does not prove capture/restore,
scoped cancellation/cleanup, fairness, or journal reconciliation. In particular,
an exchange may have accepted external work before transport failure; this
experiment's pre-dispatch retry is not permission to repeat an unsafe effect.
The caller must not reuse a stale ExecutionState to dispatch another exchange.

## Run

From the repository root:

```sh
NODE_OPTIONS=--conditions=development node --import tsx --test experiments/workflow-kernel/scoped-handoffs/__tests__/handoff.mts
pnpm exec tsc --noEmit --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions experiments/workflow-kernel/scoped-handoffs/handoff.mts experiments/workflow-kernel/scoped-handoffs/__tests__/handoff.mts
```

## Design consequence

Exchange's function signature permits concurrent invocations; each Execution
still has exactly one current suspension. Multiple tasks can therefore use the
existing contracts without inventing a second lifecycle. For compiled tasks,
the guest must serialize shared-heap advancement and capture their state as one
object graph. The host/authority must retain independently pending handoffs and
accepted settlement order. Today's concrete kernel and attachment each expose
one pending operation, so those implementations still need a deliberate extension.
The pending-set payload is one possible adapter representation, not a requirement
imposed by Flow or Exchange.

## Lua/Wasm shared snapshot proof

The `lua/` probe now uses the pinned Piccolo checkpoint codec to capture three
suspended stacks in one graph: a parent and two children whose closures share an
open cell owned by the parent. It destroys the VM, restores all stacks, settles
children in reverse order, captures again, destroys the VM again, and checks
that the parent observes `1111`. Both pre-suspension increments happen once.
The same assertions run natively and in Wasm. The Wasm test sends only JSON
between phases, creating a fresh Wasm instance for each restore.

The codec records an open cell as `{ thread, index }`, deduplicates shared cells
and heap objects across roots, allocates all restored threads before wiring
cells, and validates ownership and aggregate bounds. Missing owners, duplicate
roots, and invalid owner references are rejected. The ordinary single-task
kernel uses this same codec with one root; no second snapshot implementation is
introduced. The snapshot format advances to version 3, with no legacy reader.

```sh
python3 experiments/workflow-kernel/scoped-handoffs/build.py
node --import tsx --test experiments/workflow-kernel/scoped-handoffs/__tests__/shared-cells.mts
```

The experimental Lua scheduler now uses this graph for authored Lua `spawn`,
`join`, `all`, `race`, and `scope`. It exposes a complete pending-effect set and
consumes one identified settlement. The guest owns cancellation and scope draining;
cleanup failures from cancelled race losers are observable in snapshot diagnostics.
Completed child values remain in suspended guest frames, including closures.
Read-only restore validates and hydrates the checkpoint without replacing it.

```sh
NODE_OPTIONS=--conditions=development node --import tsx --test experiments/workflow-kernel/scoped-handoffs/__tests__/scheduler.mts
```

This is still an experimental scheduler, not production integration. The ordinary
Lua runtime has not yet adopted it; TS lowering, Hoot multi-stack execution, and
shared attachment/authority dispatch remain unfinished. Empty races currently fail
admission; scheduling is cooperative with bounded fuel and a total task budget.
Task roots are explicit codec inputs; arbitrary coroutine values remain rejected
in heap data.

`execution.mts` adapts this experimental ABI through the existing foundation
`createCheckpointExecution`, including middleware and shared lifecycle guards.
Capture is read-only; disposal drops compute state without logical cancellation.
Effect IDs survive restore while suspension IDs belong to each live handle.
This ABI currently uses site/input requests; production binding resolution and
journal provenance still belong to the upcoming shared attachment integration.

## Durable time: declared, not implemented

`timers.mts` is the experimental contract for `sleep(durationMs)`,
`timebox(durationMs, body)`, and `deadline(atMs, body)`. The scoped Lua prelude
exposes the same operations. All currently fail with
`durable_timer_not_implemented` before starting a body or emitting an effect.
This does not add TS compiler lowering or timer support to the ordinary kernels.

`DurableTimerWakeupPort` declares the missing hosting edge and fails closed.
It takes only journal-accepted wait identity and an absolute deadline, using the
existing `WaitDescriptor`. There is no driver. Its code documents crash-safe
arming, reconciliation after acceptance, duplicate/late wakeups, and authority
settlement ordering. The existing journal wait resolver's process-local delay
is not a shutdown-safe activation wakeup. No active timer belongs in a checkpoint.
