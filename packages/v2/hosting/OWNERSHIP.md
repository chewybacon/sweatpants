# Advancement and cancellation ownership

This audit describes the current primitives and the obligations of an environment
assembly. It does not introduce an exclusive execution owner, lease or remote
transport. Read it before changing cancellation or promoting placement adapters.

## Owners and authority

- The journal owns accepted history, attempt eligibility, cancellation intent and
  durable parent/child relationships. Revision checks arbitrate publication of
  recovered boundaries; attempt grants arbitrate delivery and settlement.
- The caller's native scope owns a `host.operations.run()` invocation. Hosting
  owns its delivery scopes. Recovery owns acquired Guests within the selected
  scope; `installGuestRetention` extends their lifetime only to that run.
- `createOwnedActivationDriver` owns the physical executions it starts. Its scope
  closes admission, cancels outstanding executions and joins physical cleanup.
  It is optional: a request can directly own `run()`. Each start is a new native
  root with explicit capability installation, not inherited request bindings.
- `installAttemptCancellation` owns a subscription in each executing handler's
  scope. The adapter owns routing and releases its listener through scoped
  cleanup. The subscription targets the exact attempt, not the entire host.
- The environment owns admission, invocation scheduling, physical stop policy,
  signal transport and recovery triggers. It must arrange another advancement
  pass when logical cancellation or cleanup still needs work.

There need not be one live owner for an entire durable program. Two host runs can
recover concurrently; revision checks reject stale publication. Only one current
attempt can settle a request, but explicit repeatable replacement can leave old
physical IO alive while its settlement authority is gone. Occupancy says nothing
about whether a process is still alive. An assembly needing exclusive advancement
must supply serialization; the current framework does not supply a lease.

Source boundaries: `hosting.ts` (`run`), `activation-driver.ts`, `middleware.ts`,
`../durable/src/activation.ts`, `../durable/src/journal-commands.ts` and
`../durable/src/journal-tree.ts`.

## Three distinct signal paths

**Physical stop:** an environment addresses a particular `RuntimeExecution` and
calls `cancel()`, or cancels its owning scope. This aborts cooperative IO and joins
physical cleanup. It records no durable cancellation. An unsafe attempt interrupted
before acceptance remains occupied. Restarting does not authorize its redispatch.
An old execution handle remains bound to that execution after a successor starts.

**Cooperative yield:** the environment installs `continuation` policy. Hosting
consults it between iterations, before acquisition, and returns after joined
cleanup. It cannot interrupt current IO or synchronous evaluation. A yield is a
scheduling disposition, not terminal workflow state or authority to retry an effect.

**Durable cancellation:** an authorized command invokes `cancel` at an observed
request. The journal atomically records intent and fences eligible attempts and
interactions, including owned descendants. Critical and cleanup boundaries retain
their authority. Only after commit may the command relay exact revoked grants.
Receiving subscriptions abort their local handler scopes; subsequent advancement
replays cancellation and drives logical cleanup. Aborting a handler can fail its
enclosing run; notification alone does not schedule that subsequent advancement.

Stopping an entire host in response to one revoked attempt is too broad: the host
may already be executing a fresh cleanup attempt. Likewise, parent/child durable
ownership does not imply that their physical runs share a native scope.

## Cleanup is a durable advancement barrier

Ordinary cancellation cannot cancel logical cleanup. Once a scope owes cleanup,
resumption must recover that phase; it cannot reopen the cancelled body or accept
its late results. Cleanup itself can accept outcomes and advance to subsequent
cleanup requests. The scope cannot settle past outstanding cleanup, and a parent
cannot pass its join while an owned child remains nonterminal. Independent sibling
branches can still advance. A recorded race winner is not a completed race join.

Physical shutdown can interrupt cleanup IO but does not discharge the obligation.
An unresolved unsafe attempt remains occupied across reopen. Reconciliation of its
original result can release the barrier; restart alone cannot authorize redelivery
or waive cleanup. Known failures requiring repair must be authored as nonterminal
repair waits. Existing thrown-cleanup-failure semantics still retain diagnostics and
can settle as failure; throwing is not a way to declare a resumable repair obligation.

The three-branch owned-race journey assembles failure isolation at each child run:
it captures the error for the owner and returns an unknown blocker, allowing sibling
work to finish. It does not classify every error as cancellation, mark the branch
terminal, or automatically retry delivery. The owner explicitly invokes another
advancement pass, whose journal recovery decides which work remains eligible.
Native owner shutdown can still stop the whole group.

Both runtimes cover a winning branch, a revoked live body, and a live protected
cleanup branch. Delivered/lost notifications and physical cleanup stop are crossed.
After SQLite reopen, cleanup stays occupied until an explicit simulated external
confirmation settles its original grant; the parent advances only after both
losers finish. Delayed notifications and repeated cancellation leave protected
cleanup authority intact. This is an assembly policy using existing public APIs,
not a change to the general failure semantics of `runtime.all`.

## Relay contract and placement

`AttemptNotifications` already separates sender and receiver from local execution.
Subscribe first, then inspect durable eligibility, then enter the handler under
the returned signal. A commit before subscription is detected by inspection; a
commit afterward can abort the listener. Settlement always rechecks atomically.
The adapter must finish installing its listener before `subscribe` returns.

The sender and receiver can be separately assembled hosts. They need compatible
routing, not the same JavaScript transport object. The current test rig uses a
shared in-memory bus; no production remote relay is implemented.

For a CLI or in-process application, the enclosing scope can own advancement and
local listeners. Ctrl-C policy chooses physical stop, cooperative yield, or an
explicit durable cancellation command. These choices have different resume behavior.

For a Durable Object, Lambda or AgentCore assembly, first identify the actual
invocation or supervisor holding each handler. Object addressing or pub/sub may
relay the exact attempt notification there. Object identity alone is not evidence
of non-interleaved advancement, and a new invocation is not automatically the owner
of old work. Platform lifetime and scheduling guarantees require separate evidence.

An adapter must establish the execution/tenant routing namespace and authenticate
ingress. `AttemptGrant` carries request ID, attempt ID and retry policy, not a
remote owner address or authenticated credential. A shared bus can use attempt IDs
as correlation within a trusted namespace. Descendant publications require routing
across the tree; binding every publication to only the parent's journal is insufficient.
Do not trust arbitrary remote messages to abort active scopes.

Delayed or duplicate cancellation must target only its original attempt. Fresh
attempt IDs already distinguish replacement and cleanup deliveries; no additional
owner generation is needed for this tested attempt-level relay. A future remote
command to stop an entire physical execution needs its own incarnation identity,
because an attempt grant is not a host-lifetime address. That contract is unproven.

Loss of a notification preserves fencing but can leave IO running. Publication can
fail after commit. Retained cancellation grants permit command retry, but there is
no durable outbox or guaranteed delivery. A platform requiring bounded interruption
must supply stronger delivery/reconciliation and cooperative IO guarantees.

## Acceptance evidence

- `hosting/activation-driver.acceptance.test.ts`: request versus application scope
  ownership, starts rejected during/after shutdown, joined cleanup, occupied unsafe
  delivery on reopen.
- `hosting/activation-yield.acceptance.test.ts`: safe boundary yielding and resumed
  advancement without treating physical interruption as a yield.
- `hosting/hosting.acceptance.test.ts`: competing runs, explicit replacement,
  stale settlement, subscribe/inspect races, lost publications, and physical stop
  followed by an explicit repeatable successor. Reusing the old stop handle leaves
  the successor running.
- `hosting/root-cancellation.acceptance.test.ts`: durable cancellation from another
  native root, fresh cleanup authority, delayed/duplicate old notifications while
  the cleanup run is active, and lost-notification settlement fencing.
- `hosting/owned-child.acceptance.test.ts`: parent cancellation fences descendants,
  optional local relay aborts their IO, and protected child authority survives.

Paths above are relative to `../acceptance/__tests__`. The tests use both native
runtimes and simulated peers; SQLite reopen does not prove process-crash behavior.
They establish local scope and attempt ownership, not deployed remote delivery.

## Commit observation and relay ownership

The descendant-grant change exposes committed revocations for relay without making
the journal own live tasks. Its local acceptance evidence supports that separation;
remote tree routing still needs an adapter consumer.

Journal assembly accepts `revocations`, a producer for `{ execution, grant }`. The binding
collects semantic cancellation/invalidation revocations within each transaction and
registers a synchronous `onCommit` publication. Rollback discards it. Tree traversal
captures descendant targets with their own execution identity. Ordinary cancellation
preserves critical/cleanup authority; explicit attempt invalidation can revoke that
authority and is reported too. Participant waits produce no attempt notification. Repeatable replacement is outside this notification
contract. Repeated cancellation/invalidation does not emit another observer event.

The producer is typed as `Pick<Signal<AttemptRevocation, unknown, unknown>, "send">`,
reusing the existing signal contract without a new sink interface. Supply an
assembly-owned `runtime.createSignal<AttemptRevocation>()` directly. The journal
has no subscription or close capability through this connection; its synchronous
enqueue uses the existing signal primitive. The relay
acquires the signal subscription inside its own scope before enabling writers.
Scope exit unsubscribes; sends with no subscribers are dropped, with no replay.
Transport IO happens only in the subscriber, outside the commit-publication window.
Custom producers must obey the same nonthrowing local-bookkeeping restriction. Configure it on every store assembly
that can commit cancellations, including separate invocations/connections. A receiver
still installs `installAttemptCancellation` and subscribes before inspecting authority.
The existing command middleware can also publish/retry retained cancellation targets;
using both paths may duplicate delivery, which exact-attempt subscriptions tolerate.

The old owned-group `notifications` option and post-run sibling scan were removed.
The three-branch journey pauses a separate winning invocation immediately after its
terminal commit, before `run()` returns, and proves the independent relay interrupts
the original loser without disturbing cleanup. Encoding failure rolls back the winner
and its revocations without enqueueing. Repeating direct invalidation emits only once.
The producer receives a detached grant; it does not expose mutable journal state.
Relay disposal is exercised while a loser remains live: a subsequent winner commit
produces no transport publication, and the late loser result is still rejected.
Memory-journal coverage also verifies that explicit invalidation of a critical
attempt emits once even though ordinary cancellation leaves that attempt eligible.

This is best-effort commit observation, not a durable outbox, delivery receipt or
replay feed. A process can die after commit and before enqueue/delivery; the environment
still owns reconciling durable state and routing authenticated targets to live owners.
Producer failure is a post-commit defect and does not undo the cancellation. No actual
cross-process transport is established by the in-memory signal acceptance journey.

There is also a scope-composition concern: owned groups use `runtime.all`, whose
child failure can interrupt sibling physical work. An attempt abort escapes the
child run; a protected sibling may consequently be physically stopped even though
its durable grant is preserved. Logical protection does not mask process shutdown.
Do not replace race notifications with blanket sibling-task cancellation.

The owned-race acceptance assembly now demonstrates branch-local failure isolation
and explicit re-advancement as described above. Durable commit observation supplies
the publication boundary; deployed routing, reliable delivery and environment lifetime
integration remain adapter work. No global owner registry or exclusive lease is added.
