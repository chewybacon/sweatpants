# Hosted effect execution

`createHosting(composition, { name, recovery, journal, attempts, handle })` composes
journal activation with an effect handler. Call `host.operations.run()` in a native
runtime scope. The result is inferred completion, an occupied attempt, or a registered
participant wait/invalidation.

The execution order is:

1. Activate from accepted history, park a request and dispose the computation Guest.
2. Commit an attempt grant before invoking the handler.
3. Set `host.delivery` in the handler's child scope and call `host.operations.handle`.
4. Accept the returned Outcome through the grant and receive an acceptance receipt.
5. Activate again using only accepted history.

The delivery context supplies `requestId`, `attemptId` and recorded `retrySafety`.
Use the stable request ID as an external idempotency key where the receiver supports
it. An attempt ID changes on replacement. Neither ID authenticates a remote caller.

`run`, `handle` and `retrySafety` are ordinary scoped API methods. Middleware can
wrap, replace, short-circuit or bypass them. Default retry safety is `unsafe`.
Handlers return domain Outcomes; thrown transport failures and cancellation leave
an outstanding attempt, rather than inventing an authored failure.

## Explicit replacement

Overlapping activations can fail with a journal revision conflict before reaching
attempt acquisition. Retrying activation does not itself authorize effect delivery.
A run that reaches attempt acquisition and observes an outstanding attempt returns `{ state: "occupied", grant }`
and does not call the handler. It does not infer host death from time or pending
state. A host may explicitly call `run(grant)` to replace exactly that observed
attempt. The journal atomically checks the grant, and requires both recorded and
current policy to be `repeatable`. Stale replacement fails.

Once replaced, the old attempt cannot settle, even if its result arrives before
the replacement result. The winning attempt may redeliver the same outcome and
receive its original accepted entry with `duplicate: true`; a different outcome
conflicts. Accepted history remains authoritative if the acknowledgement is lost.

This first host leaves unsafe interrupted attempts occupied. Automatic
indeterminate settlement, reconciliation and platform ownership recovery are not
implemented. Trusted external answer acceptance remains available through
`journal.accept`; it is not a grant-authenticated transport endpoint. An adapter
must validate and authenticate wire requests before using these capabilities.

## Evidence and limits

Acceptance journeys enter through hosting on both Effect and Effection, with a
scripted external service. They cover competing delivery, explicit replacement,
stale replies, recorded/current retry policy, duplicate settlement, and loss of
grant/result acknowledgements. Native shutdown journeys verify aborted delivery,
retained occupancy and policy-checked replacement. Deterministic barriers cover
revision conflicts before parking and occupied grants after both hosts activate.
Multi-request Lua journeys exercise the hosting loop with replay and checkpoints,
fresh delivery scopes, cleanup context and inferred completion results.

Memory storage commits synchronously within one process. A database adapter must
implement the same atomic transitions; this is not evidence of distributed
leases, OS-crash recovery or exactly-once external effects. Revoking a grant
prevents its journal settlement, not a service call already in flight.

## Host shutdown versus workflow cancellation

`RuntimeExecution.cancel()` stops local work, aborts delivery IO and joins physical
cleanup. An outstanding attempt remains occupied and no authored failure is
recorded. The external service may already have acted. Recovery requires the same
explicit replacement/reconciliation decision as other interrupted delivery.

A user cancelling a booking is a different operation: record cancellation intent,
run durable workflow cleanup and eventually record a cancelled terminal state.
Root cancellation at an observed parked request is implemented below. Do not
substitute native runtime shutdown for it, or run logical workflow cleanup merely
because a server is restarting.

## Participant interactions

Local elicitation is one durable pending operation. Supply `interactions` from the
same execution store and select waiting through scoped middleware:

```ts
yield *
  host.around({
    *deliveryMode([request]) {
      return request.kind === "approve" ? "wait" : "execute";
    },
  });
const result = yield * host.operations.run();
```

A `waiting` result includes the typed pending request and its `ResolutionGrant`.
Registering the same pending operation returns the same identity; it does not
create an executing attempt or accept a synthetic registration result. The live
Guest is already disposed when hosting returns. A UI can present this registered
request without an external creation effect.

Submit the answer through `host.operations.answer(grant, outcome)`, then run a new
activation. Identical delivery recovers its receipt; conflicting delivery fails.
Transport adapters must authenticate the participant and validate the response
before calling this trusted API. A resolution ID alone is not authentication.

`host.operations.invalidate(grant, reason)` atomically fences an unanswered
interaction. If an answer already won, it returns that accepted outcome instead.
If invalidation won, late answers reject and subsequent runs return `invalidated`
with the original reason. It does not insert a fabricated failure into accepted
history, reopen the request, or perform logical workflow cancellation. An invalidated
workflow remains parked until a future explicit scope-cancellation or reconciliation
protocol handles it. There is no automatic escape from invalidation in this version.

Execution attempts and participant registration are mutually exclusive for one
pending request. Changing middleware policy does not silently change that recorded
choice. Trusted `journal.accept` remains a lower-level administrative capability;
it bypasses participant authority and must not be exposed as the reply endpoint.

For an external system that must first create a ticket or approval, compose an
ordinary attempted registration effect followed by a participant wait. The accepted
ticket ID is replayed, so host replacement does not repeat successful creation.
Acceptance journeys cover both paths, answer/invalidation races, duplicate/conflicting
answers, foreign authority and mode changes. These are in-process simulations;
lexical deadlines, alarm scheduling and recoverable cancellation unwinding remain
separate work. In particular, an answer winning this request race does not decide
whether an enclosing deadline scope has been cancelled.

## Alarm boundary scaffold

`AlarmScheduler<Y>` and `AlarmReceiver<Y>` are type-only proposed contracts;
`AlarmIntent` is exported from durable and re-exported here. No scheduler, receiver,
deadline builder, persisted alarm store or alarm acceptance evidence exists yet.
They do not add required options to `createHosting` or change authored tools.

An adapter is bound to one execution. `schedule({ id, dueAt })` installs a wakeup
from already-committed intent; the immutable ID identifies a deadline instance,
and `dueAt` is an absolute Unix timestamp. Repeated identical installation is
idempotent. Changing a deadline creates a new ID so old installation/removal cannot
change a newer deadline. `cancel(id)` removes delivery infrastructure; it does not
cancel the workflow. `deliver(id)` asks the host to consult durable state.

Implementation still requires these durable transitions, not just an alarm adapter:

- Record scope/deadline identity and scheduling intent atomically. Resolve relative
  duration once using authoritative time; recovery must retain the original expiry.
- Reconcile committed intents with platform alarms, via a scan or transactional
  outbox, including recovery from lost installation acknowledgements.
- Record scope expiry/cancellation and invalidate its current wait atomically.
  An accepted answer must not erase cancellation of its enclosing scope. Enforcing
  strict deadlines also requires answer admission to consult that scope/time state;
  the current standalone interaction invalidation cannot establish this guarantee.
- Retire intent on scope exit. Ignore late/duplicate wakeups by checking durable
  state even if physical alarm removal appeared to succeed.
- Reconstruct and unwind the cancelled scope through the evaluator, allowing cleanup
  to park again. Scheduling an alarm alone does not provide this behavior.

A platform with one physical alarm per execution can multiplex several logical
intents onto its earliest wakeup. That bookkeeping belongs in the adapter; each
logical intent keeps its own immutable ID. These boundaries leave room for
Cloudflare alarms and an in-process scripted scheduler without leaking their types.

## Invalidating a live attempt

Supply `attemptControl` from the same journal, then call
`host.operations.invalidateAttempt(grant, reason)`. Acceptance and invalidation
race at storage's atomic mutation boundary. Acceptance first returns its receipt;
invalidation first rejects late settlement and explicit replacement. Repetition
preserves the first reason. A fresh host reports `invalidated` without redelivery.
Attempt invalidation alone leaves the workflow parked. Root cancellation is a
separate command that also records the evaluator transition.

For prompt IO shutdown, assemble optional middleware:

```ts
yield * installAttemptCancellation(runtime, host, journal.attemptControl, notifications);
```

Install it in both delivery and cancellation-command scopes. Notifications are
execution-bound and refer to an exact grant; remote adapters authenticate and route
them. Subscription owns scoped unsubscribe cleanup. The middleware subscribes,
checks authoritative eligibility once, and runs the handler through
`runtime.withSignal`. It publishes only after invalidation commits. If publication
fails, the command can fail after committing; repeating it safely retries notification.

Lost notifications may leave IO running, but the original grant still cannot
settle. There is no separate read before each settlement. Storage implementations
must atomically check grant eligibility and append the accepted outcome. Never
refresh a revoked grant to retry its stale result. Native interruption joins
physical cleanup and does not synthesize a domain failure.

This does not guarantee a strict token-stream cutoff across separate stores.
Partial stream batches may race cancellation; journal acceptance is the strict
boundary. A future strict cutoff requires a shared ordering mechanism.

Both native adapters are exercised through hosting with dropped notifications,
invalidation before subscription, late outcomes, acceptance winning first, and
asynchronous physical cleanup. This is in-process protocol evidence, not a
production pub/sub implementation or distributed-storage benchmark.

## Root cancellation and recoverable cleanup

`host.operations.cancel(pendingRequestId, reason)` requests cancellation at an
observed unanswered request. The journal atomically records the replay boundary
and revokes its attempt/participant grant. A stale ID rejects if acceptance won;
callers must deliberately observe and choose a new boundary rather than silently
retargeting cancellation. Repeating the original cancellation preserves its first
reason and never invalidates the new cleanup grants.

`host.operations.run()` then reconstructs and drives authored cleanup through the
same handler/participant path. Cleanup uses fresh request identities and ordinary
attempt policy. It can park, dispose and recover; previously accepted cleanup
outcomes are replayed without redelivery. Terminal results are `cancelled`, with an
optional diagnostic `failure` string for unhandled cleanup failure. Persisted
terminal results return without acquiring another evaluator.

Optional live-cancellation middleware also publishes notification after root
cancellation commits. Losing this notification cannot admit the revoked result.
The root protocol currently supports iterator replay and nested lexical finally,
not independent child-task scheduling, deadline alarms or checkpointed unwinding.
The installed Lua evaluator does not yet expose logical cancellation.
