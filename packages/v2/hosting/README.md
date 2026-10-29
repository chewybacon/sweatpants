# Hosted effect execution

`createHosting(composition, { name, recovery, journal, attempts, handle })` composes
journal activation with an effect handler. Call `host.operations.run()` in a native
runtime scope. The result is inferred completion, an occupied attempt, or a registered
participant wait/invalidation.

The default execution order is:

1. Activate from accepted history, park a request and dispose the computation Guest.
2. Commit an attempt grant before invoking the handler.
3. Set `host.delivery` in the handler's child scope and call `host.operations.handle`.
4. Accept the returned Outcome through the grant and receive an acceptance receipt.
5. Activate again using only accepted history.

Install retention as scoped hosting middleware:

```ts
yield * installGuestRetention(runtime.composition, host, recovery, journal);
```

Without that installation, activation disposes before delivery. The middleware owns
one continuation per run and supplies a scoped activation driver. Each activation
still reads current journal state, verifies the live accepted-prefix receipt, and
advances through accepted history using the same execution middleware. Local handler
output or a settlement receipt alone never advances the Guest. Recorded cancellation
is reconciled before subsequent work and applied once per live incarnation.
Checkpoint/replay middleware selects initial acquisition; subsequent reconciliation
uses the live continuation without another checkpoint restore. No lifetime flag is
passed to activation or recovery. Install with the same journal and recovery assembly
as the host. Other middleware may deliberately replace or bypass this policy.

Completion, a participant wait, an outstanding child, an occupied/invalidated attempt,
physical shutdown or failure exits the host run and joins Guest cleanup. Retention
holds native resources longer; it is not exclusive execution ownership. Concurrent
activation writes still use revision fencing. The host loop and settlement authority
are shared by both policies. This does not yet add evaluator-owned record execution.

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
with sequential owned calls as described below. Fork groups, deadline alarms and
checkpointed unwinding are not implemented.
The installed Lua evaluator does not yet expose logical cancellation.

## Sequential owned calls

The scoped `child(pending)` hook runs before attempt/participant acquisition. It
returns a child ID and a `run` capability backed by the child's ordinary host.
Return true only after that host reaches terminal settlement. False returns
`{ state: "child", childId }` from the parent host; ingress routes the next answer
to the child. No handler attempt represents the parent call.

The memory adapter's `ensureChild` binds a program/input to the exact parent
request. Repeated activation reuses it. A subsequent call, including another loop
iteration, has a new request and child identity. Child completion atomically
accepts the projected result into the parent; parent replay then consumes it.
Projection is trusted assembly, not a new authored declaration or wire validator.

Parent cancellation retains its pending call and records `cancellationRequested`.
It requests child cancellation but does not supply cancellation to parent recovery
until the child terminates. Child cleanup can wait, dispose and recover. Repeated
cancellation cannot revoke that cleanup's grants. Child settlement removes the
barrier and publishes the parent's replay cancellation boundary atomically.

The scoped evaluator (`createScopedGuest`) makes registered cleanup explicit.
Cancellation during normal cleanup retains its pending request and reply authority,
including executing attempts. Owned-call journeys now use this evaluator. A child
owned by cleanup is joined without revoking its body merely because the parent
was cancelled. Independently cancelling such a cleanup child still requires an
explicit outcome reconciliation policy; settlement rejects instead of inventing a
domain failure. Cancellation-sensitive TypeScript cleanup uses registered ensure
callbacks; arbitrary finally blocks in abandoned bodies do not run.

Parent cancellation fences live body attempts, but does not yet publish child abort
notifications through the parent's notification middleware. Losing or omitting those
notifications cannot admit a revoked result; it can leave physical IO live. Cleanup
attempts are intentionally retained and should not receive these abort notifications.

The owned-call journeys cover both runtime adapters, disposal/recovery, next-call
identity, duplicate replies, projection failure atomicity, child-first cancellation,
cleanup failure, cancellation before the first child boundary, and live late replies.
They establish process-local storage behavior, not database transactions or a
complete inferred author-facing child-call builder. No forks or races are added.

## Critical acquisition

The scoped evaluator's `scope.critical` marks body requests whose logical cancellation
must be deferred. Root cancellation records intent while preserving their grants and
any owned child call. Delivery and replay continue until the region exits; pending
cancellation then runs registered cleanup before the caller's body can resume.
The existing attempt-cancellation middleware publishes only revoked grants, so it
leaves these critical attempts live. Native host shutdown still aborts local IO.

Hosted journeys cover acquisition followed by cleanup registration, nested regions
and lexical scopes, repeated cancellation/recovery, accepted domain failure, joining
an owned child, and native shutdown retaining an occupied unsafe acquisition.

## Shared provider ownership evidence

The scoped-execution acceptance journey runs sibling hosts under a parent-owned
provider session. One sibling installs an access-restricting middleware layer and
a nested context/result override; the other keeps using the same provider facade.
Cancelling the restricted workflow drains its logical release while the sibling's
physical request remains live. Parent policy is restored after the children exit,
and only the parent closes the shared session, through an acknowledged peer exchange.

This demonstrates scoped capability composition and resource ownership under both
Effect and Effection. It does not establish security confinement: trusted TypeScript
can retain other capabilities. Native host scopes supply these bindings; logical
Guest frames do not introduce a separate capability-context API.

## Defined effect capabilities

Import `defineEffect` from `@sweatpan.ts/core` and `createEffectCapabilities` from this
package. `createEffectCapabilities(runtime, name)` creates host-owned scoped APIs:

- `install(definition, handler?)` installs a compatible default or replacement in scope.
- `api(definition)` exposes middleware over normalized context and raw successful values.
- `grant({ alias: definition })` selects typed callable capabilities and host admission.

Wire `ctx.handle` into `createHosting`, and install `host.around(ctx.admission)` before
routing middleware. Admission checks membership before delivery authority, not before
journal parking. It is deliberately composable policy, not a security sandbox.
Duplicate keys with different definition objects are rejected within one assembly.

Handlers return explicit `Outcome` data. The capability adapter validates context and
successful response values once at delivery, then carries the authored Outcome inside
a successful transport reply. Guest code can inspect both authored success and failure;
exceptions leave the attempt unsettled. Replay does not repeat delivery or validation.

`record` is sugar over an ordinary internal `defineEffect` declaration. Its implementation
is supplied per invocation rather than statically by assembly. Enable it with
`grant(definitions, { record: true })`, and install the fresh grant in each Guest's
acquisition scope:

```ts
const ctx = effects.grant(definitions, { record: true });
yield * ctx.install();
return createScopedGuest(function* () {
  return yield* ctx.record(
    function* () {
      const value = yield* runtime.fromPromise((signal) => readFile(signal));
      return { ok: true as const, value };
    },
    { key: "read-notes" },
  );
});
```

Use Guest retention to keep that scope alive through delivery. Each binding holds only
one pending operation. Work is the first argument; trailing options are optional:
`ctx.record(work)` uses positional identity, while `ctx.record(work, { key: "read-notes" })`
adds a semantic key. The default key is `$position`; an ordered Guest-wide sequence
and the journal's logical scope boundary distinguish calls during replay. Explicit keys
must be non-empty. A changed explicit key at the same position fails before the recorded
Outcome is delivered. Positional identity does not detect swapping two unkeyed operations
at the same positions; it is not a code-compatibility guarantee. Keys do not prove code identity or
provide global deduplication. Retry safety remains existing host policy, defaulting to
unsafe; repeatability must be explicitly selected by hosting middleware.

Scope exit invalidates it and drops the operation; holding the
grant does not extend its lifetime. The installed handler consumes the matching binding
once and delegates to the author's operation. It uses the ordinary effect schema,
handler, grant, settlement and replay path, without a special Guest execution method.
Native operations can use delivery contexts and register physical cleanup. Exceptions
leave delivery unsettled; authored success and failure are explicit Outcome data.
Nested durable operations are unsupported. Accepted history resumes `record` without
executing its operation; replay reconstructs only the current invocation binding.

Checkpoint-only restoration of native closures and Lua inline execution are not
implemented. Untyped Promise callbacks are rejected as non-operations; observing their
rejection cannot cancel work they already started. Lift asynchronous work through the
runtime's operations instead.

The existing generic hosting loop, journal authority and Guest protocol are unchanged.

Retention checks the exact Guest's visible execution binding before reuse. If scoped
activation or recovery middleware disposed that binding, the next activation recovers
again. Each run has its own cache, including overlapping runs through one installer.
This local lifetime check supplies no journal lease or exclusive evaluator ownership.

Initial checkpoint suffix reconciliation belongs to `recover` middleware; `advance`
middleware covers fresh replay and subsequent live advancement. Execution middleware
surrounds resume/cancel in both paths.

## Participant answer ingress

Install effect-aware answer middleware in the ingress scope:

```ts
const answers = yield * installEffectAnswers(host, grantedEffects, journal.interactions);
yield * answers.answer(resolutionGrant, { ok: true, value: rawAnswer });
// Structured authored failures do not become transport failures:
// yield* answers.answer(resolutionGrant, { ok: false, error: { code: "declined" } });
```

Use the returned answer view within its installation scope or descendants. It accepts
raw authored Outcomes while preserving the journal's transport error type.

The resolution grant selects the stored request; callers do not supply a separate
effect key or schema. The granted effect's response schema validates the successful
raw value and its returned value becomes the accepted authored Outcome. A strict
numeric schema rejects strings; a transforming schema may convert them. The framework
adds no coercion. Authored failure Outcomes bypass the success schema, as they do in
handler delivery. Schema failures leave the exchange unanswered.

No handler executes and request context is not reparsed on this path. Generic journal
acceptance still takes prepared transport Outcomes. Middleware supplies that envelope
and delegates; final acceptance rechecks resolution authority atomically after schema
validation. The earlier request lookup is not a lease. Intentional middleware bypass
remains trusted assembly policy, not a remote authentication mechanism.

Replay consumes accepted values without rerunning schemas. A repeated live submission
validates again and compares normalized Outcomes: two raw forms producing the same
value are duplicates, while conflicting values reject. Response transformations should
be deterministic and side-effect-free, and their output must be supported by the store's
serializer. Install this middleware once per answer-ingress chain.
