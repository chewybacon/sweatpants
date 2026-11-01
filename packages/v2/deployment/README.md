# Activation reconciliation

`createActivationReconciler(composition, name, { intents, run })` binds one known
root tree's activation intent to the application's existing Host assembly. It
exposes `operations.reconcile()` and the exact `intents` API used internally.
Assembly must supply a `createActivationIntents` API. Reconciliation dispatches
through that exact instance and exposes it unchanged; it never wraps raw storage
commands implicitly. Native-root capability installation still belongs inside the
application work.

```ts
const intents = createActivationIntents(composition, "activation-intents", store.activations);
const reconciler = createActivationReconciler(composition, "activation", {
  intents,
  run: () => host.operations.run(),
});
const report = yield * reconciler.operations.reconcile();
```

A pass reads a pending token, drives once, and acknowledges only that original
token. No token returns `idle` without acquiring a Guest. Yield returns `driven`
with `acknowledged: false`. Only terminal roots and known participant waits attempt
acknowledgement. Occupied, invalidated, and unknown child states retain intent:
a concurrent observer must not clear the only recovery signal for delivery that
can still fail without a journal write. Child adapters use `childHostingResult` and
`joinChildHostingResults` to preserve those distinctions through the root result.
The supplied run must drive the same tree as the intent capability.

Drive errors propagate without this pass acknowledging. Intent acknowledgement
itself can commit deletion and then throw (including through middleware); reread
intent after that failure rather than assuming rollback. A concurrent write still
cannot be erased by comparison against an older token. Raw intent capabilities and
facades are bound to their storage connection: reassemble after closing/reopening it.

Host progress itself often replaces the token, so even a completed or parked pass
can return `acknowledged: false`. A later quiescent pass can clear it. A recovery-only
revision/checkpoint refresh preserves intent and does not cause endless wakeups.
False can also mean another reconciler acknowledged the token; it is not proof that
pending work remains. Read again on the next scheduled pass. Do not busy-loop on
false, on yielded results, or on occupied unsafe delivery. Occupied/invalidated work
can remain pending indefinitely until authorized intervention or live settlement;
platforms must back off or surface it for operators. This preserves discoverability,
not permission to retry. Legacy boolean child callbacks returning false are unknown
blocking and conservatively remain pending.

## Storage and ingress

Memory and SQLite journal stores expose `activations`:

- `read()` returns the current `{ execution, token }`, or undefined.
- `request()` explicitly creates/replaces pending intent, including for a new root
  that has not been admitted. Requests coalesce rather than forming an event log.
- `acknowledge(observed)` clears only an exact token for that root. It returns false
  for stale/already-cleared tokens and rejects a foreign execution.

Journal writes automatically persist root-tree intent in the same transaction.
This includes admission, accepted answers, child transitions, and cancellation.
A child answer therefore makes its owning root discoverable through that root's
intent capability. Checkpoint/revision refresh of an existing pending boundary
preserves intent; it cannot resurrect acknowledged work by itself. Rollback leaves
intent unchanged. Intent acknowledgement changes neither journal revision nor
attempt/participant authority.

An ingress handler need not call a queue successfully after accepting an answer.
The durable token is already present even if the process stops before that call.
A platform wakeup can reduce latency, while a periodic reconciler over the platform's
known execution catalog repairs missed wakeups. Tokens and execution IDs are data;
scopes, Host instances and closures remain local assembly.

## Ownership and limits

This package implements a single reconciliation pass. It does not yet implement a
platform scheduler, global execution catalog/discovery, alarm, queue, process lease,
or autonomous polling supervisor. The platform/application must retain root identity
and program assembly, arrange future passes, and choose delay/backoff and concurrency.
Without that owner, durable intent alone does not guarantee eventual execution.

A local activation driver can own work that invokes `reconcile()`. Configure that
work inside its native root as usual. This does not make a local execution handle a
remote scheduling protocol. Reader connections do not own reconciliation.

Duplicate passes are allowed; intent is not exclusive activation ownership.
Journal attempt authority still prevents unauthorized delivery. An unsafe occupied
attempt remains occupied; elapsed time and pending intent grant no retry permission.
A failed acknowledgement after accepted delivery recovers accepted history instead
of repeating the provider call. Raw intent commands and replaceable API drivers are
trusted assembly capabilities, not an authentication boundary or quota ledger.

Memory intent is process-local. SQLite intent survives the tested connection/store
reopen and is atomic with its root tree. Acceptance exercises both runtimes and both
stores, including a separate SQLite connection writing before acknowledgement,
missed scheduling after answer acceptance, nested child wakeup, failed projection
rollback, cooperative yield, overlapping root/child delivery, cancellation ingress,
and before/after-delete intent acknowledgement failures. A separate application
journey combines owner lifetimes, reader disconnect, yield/shutdown, and fresh-owner
reconciliation. These are
in-process recovery journeys, not OS-crash, power-loss, or deployed-cloud evidence.

## Concrete consumer evidence

Two application-local consumers exercise this API without new framework ports:
[finite request commands](../acceptance/__tests__/applications/request-consumer.acceptance.test.ts)
and a [persisted SQLite sweep](../acceptance/__tests__/applications/sweep-consumer.acceptance.test.ts).
Both reconcile directly in their invocation scope. Request output uses a captured
accepted-history endpoint; the sweep persists admission-gated traversal and backoff
keyed by intent token. Neither reader demand nor advisory report delivery authorizes
effects. See the [acceptance limits](../acceptance/__tests__/README.md#concrete-activation-consumers)
for transport, containment and recovery boundaries. These are executable assembly
examples, not shipped HTTP or platform scheduler adapters.
