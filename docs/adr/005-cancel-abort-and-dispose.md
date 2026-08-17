# ADR-005: Cancel, abort, and dispose are different operations

**Status:** Accepted

## Context

Sweatpants uses demand-pulled execution. `ProgramRuntime.run()` turns the crank. A program advances until it parks on an unresolved input or outcome, or reaches a terminal outcome.

Earlier designs used "cancel" for three different operations:

- asking a program to terminate with a cancelled outcome;
- stopping active process-local work;
- releasing resources after work ends.

That ambiguity made parked work look as if it needed an out-of-band signal. It also made an `AbortSignal` look like durable proof of cancellation. Neither is correct.

## Decision

Sweatpants uses the following terms.

### Cancel

Cancel is a semantic request to terminate a computation with a cancelled outcome.

The Journal Authority records durable cancellation. The runtime delivers cancellation through the normal crank protocol. A parked program receives cancellation as its next resume input and runs its authored `catch` and `finally` cleanup.

A parked branch has no active computation to abort. Cancellation marks it runnable and schedules a crank.

```text
CancellationRequested
  -> task becomes runnable
  -> ProgramRuntime.run()
  -> replay to cancellation frontier
  -> inject typed cancellation
  -> run authored cleanup
  -> record cancelled outcome
```

### Abort

Abort is an operational request to stop active work now.

Abort applies to an active attempt, pull loop, provider request, worker, process, or Effection scope. It is process-local or placement-local. `AbortSignal` is one adapter for APIs that support cooperative abort.

Abort is not a durable outcome and does not prove that the program was cancelled. Request disconnect, host shutdown, ownership loss, and process replacement may abort live work without requesting semantic cancellation.

When the authority accepts cancellation while work is active, it may abort the active attempt so the runtime can reach the cancellation frontier. The later crank still delivers semantic cancellation.

```text
CancellationRequested
  -> abort active attempt
  -> settle or classify the attempt
  -> crank program at cancellation frontier
  -> inject typed cancellation
  -> record cancelled outcome
```

### Dispose

Dispose releases owned resources after they are no longer needed.

Disposal closes scopes, workers, subscriptions, queues, buffers, and handles. It does not choose a semantic outcome. Normal completion, failure, cancellation, host shutdown, and process replacement may all cause disposal.

The owner records or preserves the terminal outcome before deleting state required to recover it.

## Pull loops and streams

The scope that calls `subscription.next()` owns that active pull. Aborting the scope stops the pull and propagates a scope-bound `AbortSignal` to provider SDKs, fetch requests, workers, or processes.

Model and tool UX events use two pull loops with a buffer between them:

```text
live source
  <- owner calls subscription.next()
  -> bounded ephemeral buffer
  <- public reader pulls
```

The owner may pull a provider stream eagerly during one active crank so a slow public client cannot cause a provider timeout. Public readers pull only the buffered projection. Reader disconnect does not cancel the program or abort the owner pull.

The journal records completed responses, asks, and terminal outcomes. It does not record model deltas, tool progress, or logs emitted only for live UX.

## State rules

| State | Cancel | Abort | Dispose |
| --- | --- | --- | --- |
| Parked | Schedule a crank with semantic cancellation | No active work to abort | Only for host lifecycle or terminal cleanup |
| Active | Record semantic cancellation, then stop or settle active work | Stop the active attempt or owner scope | After the attempt or owner releases resources |
| Terminal | Return the accepted terminal outcome | Nothing active to abort | Release retained resources under policy |
| Owner lost | Recover from accepted durable state | Live work is already gone | New owner cleans recoverable stale state |

## Interface rules

- Public program and invocation interfaces use semantic cancellation values, not `AbortSignal`.
- `AbortSignal` stays at live API boundaries and never enters persisted state, public projection, or durable identity.
- A response to a parked ask and a cancellation of that ask both advance the program through the same crank operation.
- An out-of-band abort targets only active work. It does not target a parked continuation.
- Disposal is safe to repeat and does not fabricate success, failure, or cancellation.
- Force orphaning remains separate. It records that graceful cancellation or cleanup could not be completed.

## Consequences

A tool invocation can expose one pull-based `turn()` operation. `turn()` accepts either a response to the pending ask or semantic cancellation. The host needs a separate internal route only for aborting an active turn.

Durable cancellation no longer depends on a live owner when the program is parked. The authority marks the task runnable, and any eligible host can perform the cancellation crank.

Active work still needs direct process-domain ownership. The owner scope has access to the live subscription, worker, child tasks, and abort-aware external handles. Remote placement implements the same rule through a remote abort command and acknowledgement.

## Related decisions

- [ADR-001: One Crank Turner and Demand-Pulled Execution](./001-one-crank-turner.md)
- [ADR-002: One Host-Owned Reconnect Log](./002-one-host-owned-reconnect-log.md)
- [Durable Tool Cancellation and Partial Results](../../../.pi/specs/durable-tool-cancellation-spec.md)
