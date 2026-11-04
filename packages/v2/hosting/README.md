# Hosted effect execution

See [advancement and cancellation ownership](./OWNERSHIP.md) for the primitive
boundaries, environment assembly obligations, relay targeting and current limits.

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

Ordinary runs reread after a journal revision conflict before attempt acquisition.
Reactivation does not itself authorize effect delivery. Explicit `run(grant)`
replacement propagates conflicts rather than carrying permission to another boundary.
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
Return `childHostingResult(result)` to preserve terminal, yielded and blocked
outcomes. The parent retains child blocking reasons; ingress routes answers to the
child. Legacy false returns an unknown `{ state: "child", childId }` disposition. No handler attempt represents the parent call.

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

Parent cancellation fences live body attempts in the same transaction and records
their grants as `descendants` on the parent's cancellation. The parent's
`installAttemptCancellation` publishes each one; a child host subscribed through the
same transport aborts its physical IO. Losing or omitting those notifications cannot
admit a revoked result; it can leave physical IO live. Cleanup
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

Answer-only consumers can compose the existing operations without a Host:

```ts
const request = yield * journal.interactions.request(resolutionGrant);
const outcome = yield * grantedEffects.respond(request, { ok: true, value: rawAnswer });
const receipt = yield * journal.interactions.answer(resolutionGrant, { ok: true, value: outcome });
```

The application must resolve the intended execution and select its original effect
declarations. Projected contracts are discovery data, not grant authority. This direct
composition does not invoke Host middleware; authorization and routing remain explicit
application responsibilities. Validation may suspend, so the final answer operation
must recheck authority atomically. No Guest acquisition is needed.

For an existing Host, install effect-aware answer middleware in the ingress scope:

```ts
const answers = yield * installEffectAnswers(host, grantedEffects, journal.interactions);
yield * answers.answer(resolutionGrant, { ok: true, value: rawAnswer });
// Structured authored failures do not become transport failures:
// yield* answers.answer(resolutionGrant, { ok: false, error: { code: "declined" } });
```

Use the returned answer view within its installation scope or descendants. It accepts
raw authored Outcomes while preserving the journal's transport error type. Acceptance
continues through the remaining Host middleware chain.

The resolution grant selects the stored request; callers do not supply a separate
effect key or schema. The granted effect's response schema validates the successful
raw value and its returned value becomes the accepted authored Outcome. A strict
numeric schema rejects strings; a transforming schema may convert them. The framework
adds no coercion. Authored failure Outcomes bypass the success schema, as they do in
handler delivery. Schema failures leave the exchange unanswered.

No handler executes and request context is not reparsed on this path. Generic journal
acceptance still takes prepared transport Outcomes. The middleware supplies that envelope
and delegates; final acceptance rechecks resolution authority atomically after schema
validation. The earlier request lookup is not a lease. Intentional middleware bypass
remains trusted assembly policy, not a remote authentication mechanism.

Replay consumes accepted values without rerunning schemas. A repeated live submission
validates again and compares normalized Outcomes: two raw forms producing the same
value are duplicates, while conflicting values reject. Response transformations should
be deterministic and side-effect-free, and their output must be supported by the store's
serializer. Install this middleware once per answer-ingress chain.

## Reactivation after a cancellation race

Cancellation may commit after a host observes a pending boundary but before it
registers a participant wait or begins an attempt. Durable commands signal these
pre-delivery races with `JournalConflict`. Ordinary `run()` rereads and reactivates
in the same call, continuing pending logical cleanup. Revision conflicts during
activation are handled the same way. Direct activation remains a single attempt.

Only these typed conflicts are recoverable. Delivery-mode policy, handler execution,
settlement, storage failures and divergent replay are not blanket-retried. Explicit
attempt replacement still rejects a stale expectation. Owned routing reactivates a
parent whose boundary advanced before child acquisition, but does not catch errors
from executing child hosts. Each child host owns its own pre-delivery recovery.

`Composition.catchError` bridges native API/scope error propagation on both runtimes.
It creates no scope and does not convert native cancellation into retry permission.
The deterministic sibling-cancellation journey now drains to the next cleanup wait
without a caller retry; async replay and competing-host journeys check reactivation
without duplicate delivery. The host still returns normally for a parked, occupied,
or explicitly invalidated request; this is not a polling or liveness guarantee.

## Inline owned groups

`createOwnedAll<BranchContext, BranchInstructions, NativeYield>(runtime, name)`
composes an ordinary effect with journal-owned children. Keep its name stable and
unique within the pinned parent program. Include `owned.effect` in the parent's
explicit effect grant and install admission before owned routing.

```ts
const owned = createOwnedAll<BranchContext, CapabilityRequest | ScopeInstruction, Y>(
  runtime,
  "review.all",
);

// Inside each parent Guest acquisition:
const all = yield * owned.acquire();
return createScopedGuest(function* () {
  return yield* all(
    function* (branch) {
      return yield* branch.elicit("Approve?");
    },
    function* (branch) {
      return yield* branch.compute("research");
    },
  );
});

// In the surrounding hosting scope:
yield *
  owned.install({
    host,
    journal,
    recovery,
    run(child, factory, index) {
      return runChildHost(child, factory, index);
    },
  });
```

`runChildHost` is host assembly: acquire a scoped Guest from `factory(childContext)`,
grant its permitted capabilities, and run ordinary hosting against `child.journal`.
Return true after terminal settlement, false when parked or occupied. The callback
runs concurrently with siblings in separate runtime scopes. It owns application
routing and participant delivery; the group middleware owns durable grouping.
Named tool calls inside factories use their ordinary owned invocation path, adding
a tool journal beneath the branch journal.

The authoring callable `All` and factory type `Branch` live in core. Results retain
ordered tuple inference. Empty groups return locally. Explicit failure Outcomes
remain result data; delivery exceptions propagate and do not synthesize failures
or automatically cancel siblings. Cancellation uses the existing journal tree rules.

Acquire once per parent incarnation. Physical scope exit closes the callable and
releases its factories without authored cleanup. Parent replay recreates factories
at their original group positions. Every group drive reconstructs its parent in a
temporary owning scope and checks the suspended request and logical scope against
the journal before driving children. Reconstruction removes the parent checkpoint
to force replay. Inherited bindings are never reused: an ancestor can have the same
group slot. This adds parent replay on each group drive; no retention flag is added
to journals.

Captures must be reproducible from pinned code, input and accepted results. Shared
mutable captures, standalone child recovery without parent reconstruction and remote
closure placement are unsupported. Pass each branch its own scope and local grants;
do not capture the parent's scope or recording binding. Program identity must change
when branch ordering or replay-relevant code changes. Slot identity cannot detect
same-count reordering under an incorrectly reused program identity.

The host, recovery and journal must describe the same execution. Owned authority
must remain in one transaction domain. This API neither grants effect permission
implicitly. Its host reactivates typed pre-delivery conflicts without retrying handlers.

## Inline owned race

`createOwnedRace` uses the same scoped acquisition and installation as `createOwnedAll`.
Its nonempty `race(factory, factory, ...)` returns the union of branch result types.
The first child to commit terminal completion wins, including that child's logical
cleanup. An authored failed Outcome can win; a delivery exception remains unsettled.

Winner selection and cancellation of eligible losers commit atomically. The winner
is durable across reopen and cannot be replaced by a late protected result. The parent
receives it only after every loser finishes logical cleanup. Critical regions and
cleanup retain authority, so a protected or parked loser can delay return indefinitely.
A loser cleanup failure follows owned cancellation semantics rather than silently
returning the winner; a protected parent still requires explicit reconciliation.
Parent cancellation takes priority over returning a winner.

Race shares all's replay reconstruction and local-closure placement restrictions.
Hosting reactivates typed pre-delivery conflicts. Race adds no handler retry policy.
Configure journal `revocations` on every committing store assembly to enqueue
exact `{ execution, grant }` targets after confirmed commit, including nested losers.
Supply an assembly-owned `runtime.createSignal<AttemptRevocation>()` as the
producer; the journal's contract exposes only its `send` capability. A separately owned relay subscribes before enabling writers and publishes
to the transport used by each handler's subscription. Relay scope exit unsubscribes;
values sent with no subscriber are dropped, not retained for a future relay.
This works before the winning host returns and does not depend on the losing group
advancing. The producer performs only nonthrowing local bookkeeping, never remote IO.
Delivery is best effort; loss leaves IO live but cannot admit a late result. Repeated
commands do not re-emit observer events; retained cancellation facts remain available
for explicit reconciliation/retry. Physical relay lifetime and routing are assembly
responsibilities. See [ownership](./OWNERSHIP.md).

## Two researchers, each racing sources

The [research acceptance example](../acceptance/__tests__/applications/research-races.acceptance.test.ts)
composes both APIs without another execution primitive. Its host supplies each
child context with fresh `scope`, `all`, `race`, and granted effect calls:

```ts
function* researcher(ctx: Context, topic: string) {
  yield* ctx.scope.ensure(function* () {
    yield* ctx.release(topic);
  });
  return yield* ctx.race(
    function* (branch) {
      return yield* source(branch, `${topic}/primary`);
    },
    function* (branch) {
      return yield* source(branch, `${topic}/backup`);
    },
  );
}

const findings =
  yield *
  ctx.all(
    function* (branch) {
      return yield* researcher(branch, "security");
    },
    function* (branch) {
      return yield* researcher(branch, "performance");
    },
  );
// [Finding, Finding], in researcher declaration order.
```

`source` uses its own context to register cleanup, request a source response, and
return `{ source, text }`. Each researcher's race waits for source cleanup, then
that researcher runs its own cleanup. The outer all waits for both researchers
before returning the ordered findings. Root cancellation fences unfinished source
requests and drains the same cleanup hierarchy without returning findings.

The example runs with ordinary and retained activation on both runtimes, reopens
SQLite while losers need cleanup, and checks that a completed winner stays complete.
That example controls source terminal-commit order to isolate composition. Separate
hosting journeys force stale observations and verify automatic reactivation. Neither
establishes remote placement, live provider behavior, or crash recovery.

## Optional assembly facades

`createChildRunner` wraps the existing all/race runner callback in an ordinary Api.
Its driver remains bound to the application's branch/context contract and owns each
fresh child assembly scope. Reconstructed factories must not escape the parent
reconstruction lifetime. Successful activation alone does not mean terminal child
settlement. Installations are scoped; inherited grants must not be reused for children.

`createAttemptNotifications` provides scoped transport selection around the existing
subscribe/publish contract. Existing signals retain their source and owner. Preserve
subscribe-before-inspect and publication after committed invalidation. Publication
failure cannot undo acceptance or invalidation.

## Attempt API ownership

`createHosting` binds raw `options.attempts` once and exposes the facade as
`host.attempts`. All host begin/settle calls go through its operations. Install
observation or scoped replacement on that exact instance before running the host.
Pass an existing `Api<Attempts>` directly to preserve its identity and middleware;
passing only its operations remains supported, but adds a host-owned outer facade.
Do not replace attempt storage with a journal belonging to another execution.

## Application-owned activation

`createHostedActivation(runtime, { run, present })` starts one eager native root.
Install scoped capabilities inside `run(emit)` and drive `host.operations.run()`
there. Emitted frames are provisional. The caller owns the activation handle and
must cancel it when its application lifetime ends; an HTTP reader does not own it.

`activation.from(after, compact?)` acquires an independent buffered reader in the
subscriber's scope. Disconnect releases only that reader. Production continues
without readers; offsets and retained values belong to this activation instance.
The buffer is unbounded and in-memory, with values retained by reference.

`result` settles only after execution cleanup and synchronous settled presentation.
Optional `present(result)` derives final frames after cleanup, before stream close.
It must not perform effects or journal writes. Failure in execution, cleanup or
presentation retains provisional frames followed by failure, never a successful
stream terminal. Presentation failure cannot undo accepted journal facts. `cancel()`
joins cleanup and output settlement, is idempotent, and does not reject; inspect
`result` or read the stream to observe failure.

This is physical activation ownership, not a durable session supervisor, event log,
publication receipt or automatic retry mechanism. Recovery of accepted-but-unpublished
state is a separate concern. Existing readers do not follow a replacement activation.

## Recovering presentation after publication loss

`createJournalPresentation(composition, name, journal)` binds a read-only scoped
`read(after?, limit?)` operation. It returns bounded accepted entries, a receipt-
anchored cursor and current durable state, including an already-registered wait.
Journal state and its registration are read atomically. Reading never registers a
wait, acquires a Guest, drives hosting, or invokes a handler. Accepted receipts and
resolution grants survive journal reopen; live buffer offsets do not.

Application assembly projects these trusted data into public frames. Checkpoints
and root admission input are omitted from presentation state, but accepted requests,
child input and outcomes can contain private data: this is not a wire-safe public
projection or authorization boundary. Scoped middleware can apply read policy.

Advance a consumer cursor only after applying the entire page. If acknowledgement
is lost, reread the previous cursor and apply by stable receipt identity. The cursor
contains execution identity, accepted count and the last receipt; foreign or
mismatched prefixes reject. Bound the page size explicitly when needed. Drain pages
until `caughtUp` when reconstructing the full accepted history. Each read captures a
prefix, but separate page reads can observe newer state as execution advances.

Running presentation also retains `cancellation` and `cancellationRequested` from
the same journal snapshot. The latter is accepted intent waiting for owned children
before the parent can unwind. A pending request's `scope` distinguishes body, cleanup
and critical protection when the evaluator supplies it. These are durable observations,
not proof of a live driver; `status: "running"` does not mean cancellation is absent.
Cancellation records include request/control data and require the same trusted-to-public
projection as other journal facts.

Current state is returned even with no new accepted entries, so registered waits,
invalidation and completion are not lost behind an unchanged history cursor.
An exposed grant may become stale immediately afterward; answer ingress must still
recheck authority. Registration reads never resurrect revoked grants.

This supports reconstruction after acceptance-but-before-publication failure. It
is not a durable publication acknowledgement store or exactly-once transport.
Projection versioning, recipient authorization, stable public event identities,
client acknowledgement storage and recursive child presentation remain application
concerns. Recovery does not replay provisional provider token deltas.

## Required compensation and repair

A cleanup obligation can remain nonterminal using an ordinary protected participant
request. If compensation returns a **known accepted failure**, application cleanup
can request repair and wait for its answer before returning. The original failure
remains accepted history; the repair decision is a separate accepted outcome. The
owned parent continues waiting for the child. Do not throw and then assume the ended
cleanup callback can be resumed: authored cleanup exceptions still follow the existing
failure/settlement contract, including terminal cancellation with diagnostics.

The [signup compensation assembly](../acceptance/__tests__/applications/signup-compensation.acceptance.test.ts)
uses `ensure` and `critical` with a replay-reconstructed commitment flag. Acquisition
and compensation registration share a critical region. Its explicit commitment policy
allows commit to proceed once its protected region is reached, even if cancellation
is then accepted before delivery. A successful accepted business commit suppresses
compensation; it does not promise a successful kernel terminal disposition after
cancellation. Critical is a cancellation mask, not an external transaction.

A denied release parks a `repair` request containing the resource and failure reason.
The application's operator ingress checks authorization and the exact interaction,
validates a decision with evidence, and uses existing answer acceptance. It supports
confirmation of external repair or explicit waiver; a waiver can leave the resource
present and is never claimed as successful rollback. The accepted repair decision
retains that distinction. The authorization boolean in this journey is a test policy
input, not a production authentication mechanism or public repair API.

Reconciliation may clear intent while this known participant wait remains readable.
Answer acceptance creates root-tree intent again. Lost acknowledgements reuse the same
grant/decision; conflicting answers reject. Reopening and reading cancellation plus the
repair request does not acquire a Guest. With multiple resources, a blocked newest
compensation delays earlier LIFO callbacks until repaired; no independent cleanup
scheduling or parallel compensation dependency policy is provided.

An **unknown external outcome** takes a different path: commit or release delivery
without acceptance remains occupied. It is neither a known failure nor an automatic
repair interaction, and this assembly provides no unsafe retry or forced success.
The parent stays nonterminal and intent remains discoverable. External reconciliation
for such attempts is not implemented by this example.

Acceptance covers both native runtimes, one/two resources, repair and waiver, stale
and duplicate ingress, owner loss after acquisition/release/commit acceptance, protected
commit races, uncertain delivery, and SQLite reopen. These are TypeScript workflows
through the local execution protocol. They do not establish Lua critical-region parity,
checkpoint recovery during cancellation, global DLQ discovery, a recursive frontier,
or OS-crash/external-service atomicity guarantees. No new scope exit-read API or storage
repair registry was required for this explicit participant-repair assembly.

## Scoped activation drivers

`createOwnedActivationDriver(runtime, work)` acquires an activation owner in the
current scope. `createActivationDriver(composition, name, owner)` exposes its
`start()` through an ordinary scoped API. Start consumers invoke that same
facade's `operations.start`; middleware can observe or substitute the owner.

```ts
// Inside an application supervisor scope:
const owner =
  yield *
  createOwnedActivationDriver(runtime, {
    *run() {
      // Install capabilities here: each activation starts a fresh native root.
      return yield* host.operations.run();
    },
  });
const driver = createActivationDriver(runtime.composition, "activation", owner);
const execution = yield * driver.operations.start();
```

Acquire the owner inside a request scope for request-bound execution. Acquire it
in an enclosing application supervisor for background execution: starts from a
shorter-lived request remain owned by that supervisor. A request can install its
own acquired owner on the same facade; scope exit restores the enclosing selection.
Both policies use the same ownership implementation. An operation facade resolves
current policy, while an already-started execution retains its original owner.

Every start creates a fresh physical execution. Owner exit closes admission to
new starts, cancels all remaining executions, and joins their cleanup. Completed
executions are released from the owner's tracking set. Escaped owner handles reject
starts after shutdown. Execution and cleanup failures remain observable through
`execution.result`; owner shutdown, like `RuntimeExecution.cancel`, does not rethrow
their failures. Applications must arrange their own failure observation policy.

The work must invoke the existing Host API and configure native-root capabilities
inside `run`. Starting a root does not inherit the request's context bindings.
This driver owns no response buffer: output streams and readers retain independent
lifetimes. `createHostedActivation` remains an explicit execution-and-output
convenience with its own caller-owned handle; it is not automatically registered
with an activation driver.

Physical shutdown is not durable workflow cancellation or a safe scheduling yield.
An interrupted unsafe delivery remains occupied. This API does not deduplicate
starts, lease an execution, retry delivery, or schedule recovery after process death.
The activation-driver acceptance journey exercises real hosting and SQLite reopen
on both runtimes, plus joined multi-activation shutdown. It is in-process evidence,
not process-loss or remote-supervisor coverage.

## Cooperative activation yielding

`host.operations.continuation()` is a scoped policy operation, defaulting to
`{ action: "continue" }`. Hosting consults it before every iteration, including
before the first activation. Middleware can return
`{ action: "yield", reason: "budget" }`; `run()` then returns
`{ state: "yielded", reason: "budget" }` after its owned scopes finish cleanup.

```ts
let accepted = 0;
yield *
  host.attempts.around({
    *settle(args, next) {
      const result = yield* next(...args);
      accepted++;
      return result;
    },
  });
yield *
  host.around({
    *continuation() {
      return accepted >= limit
        ? { action: "yield", reason: "acceptance budget" }
        : { action: "continue" };
    },
  });
const result = yield * host.operations.run();
```

This example counts successful settlement calls in this assembly; it is not a
persisted usage meter or exactly-once billing. Configure a fresh budget when the
owner starts another activation. Middleware can instead consult an owner stop
flag or elapsed time. Continuation is outside stale-journal conflict recovery:
policy failures propagate and are never converted to a retry.

The gate precedes activation, child routing, and new authority acquisition. It
runs again only after the previous delivery has settled and its cleanup has joined.
Yielding releases retained Guest scopes. It creates no participant registration,
logical cancellation, scheduler intent, or permission to replace an occupied attempt.
A yielded result is an owner scheduling disposition, not proof that the underlying
journal is nonterminal: a zero budget can yield before reading an already-completed
journal. Resume with `run()` under a policy that permits progress.

Configure continuation policy on child hosts explicitly; independently created
facades do not share policy identity. Convert results with `childHostingResult`:

```ts
return childHostingResult(yield * childHost.operations.run());
```

The helper returns true for terminal settlement, preserves a yield, and otherwise
returns an explicit blocked reason (waiting, occupied, invalidated, or unknown).
Parent Host results retain that reason as `{ state: "child", childId, reason }`.
Legacy true/false callbacks remain accepted, but false means unknown blocking;
reconciliation must not mistake it for a quiescent participant wait. Participant
grants and child output still belong to their owning journals/application views.

Owned all/race joins every started child before calling `joinChildHostingResults`
and releasing replay-reconstructed factories. Custom group assemblers should use
the same helper after joining children. It preserves the first yield in declaration
order; otherwise unknown, occupied and invalidated blockers take precedence over
waiting. Only an all-terminal group returns true. `results.every(Boolean)` is
incorrect for these results. Named tool routing accepts the same child contract.

A shared stop flag can prevent further work at each child's next boundary; it does
not preempt children already delivering or evaluating. No hard deadline, global
concurrency bound, immediate stop of sibling work, or fair scheduling is implied.
An owner killed during delivery still follows occupied-attempt semantics.
Acceptance covers zero-budget acquisition avoidance, accepted-prefix recovery,
cleanup barriers, scoped policy restoration, and nested all/race reconstruction
across SQLite reopen with retained and disposable Guest lifetimes.

### Observing an owned-tree interaction frontier

The `tree-frontier.acceptance.test.ts` application recursively composes journal
presentation with durable `JournalReader.openChild`. A nested Lua approval and a
sibling Lua cleanup-repair request remain independently discoverable and answerable.
The compensation branch enters cleanup through an application decline; it does not
independently cancel a child and assume its siblings are unaffected.

An occupied sibling can dominate the root scheduling report without hiding another
journal's registered interaction. A yielded branch may have accepted its last outcome
without publishing its next request; observation cannot manufacture that next boundary.
The example records each node's execution, parent and revision. It does not promise a
single atomic tree snapshot, infer live advancement from stored state, or expose a new
framework frontier API. Navigation and payload access still require application
security policy before use by an untrusted client.

The same assembly also runs two independent Lua cleanup branches. One may finish
while the other waits for repair; both may register separate repair grants; or one
may remain occupied while its sibling's repair is answered. Parent cancellation
preserves these protected cleanup boundaries and joins every unresolved branch.
Answering one repair does not imply resolution of another branch's uncertain effect.
This is explicit application independence across owned children, not automatic
parallelization of a single scope's ordered cleanup callbacks or arbitrary saga
compensations. The 32 frontier cases cover both stores and both native runtimes.

### Typed interaction projection and answers

The tree-frontier application keeps a local contract registry pinned to its known
Lua programs. Its context schemas also decode Lua requests. Each interaction projects
an execution identity, contract key, exact grant, observed revision, scope boundary,
cancellation facts, title, decoded context and JSON response schema. These are finite,
serializable render inputs; no Guest acquisition or framework frontier export is needed.
The schemas are application declarations, not inferred from arbitrary Lua source.

The answer route resolves the execution within the application's owned tree, reads
the stored request for the supplied grant, checks the pinned program and contract,
authorizes the role, and validates the response before atomic journal acceptance.
Submitted rendering metadata is not authority. The typed client convenience preserves
contract/answer correlation, while the ingress route still accepts and validates unknown
values. Repair confirmation retains evidence in accepted history. Duplicate submissions
survive reopen, including after terminal settlement; conflicting evidence rejects.

The example filters operator-only repair prompts from participant views and tests
malformed input, foreign execution/grant, contract mismatch, stale authority and
independent answers. Its role argument is simulated policy, not authentication; production
transport, identity and redaction remain application work. Historical command routing
for this pinned assembly is described below. JSON-schema projection is demonstrated for these Zod schemas,
not every Standard Schema implementation. The focused suite now has 36 cases.

### Resolve several interactions, then advance the tree

The frontier experiment exposes a local `advance({ answers, maxIterationsPerHost },
role)` edge operation. Each answer carries its execution, contract, exact grant and
value. The operation attempts answers in input order, then drives all eligible owned
branches, including logical cleanup, and returns per-answer outcomes, the hosting
report and the next role-filtered frontier. It owns one native task through acceptance,
advancement and observation. The budget is validated before any acceptance.

Acceptance is atomic per answer, not across the envelope. Confirmed results include
receipt and duplicate status; exceptions are `unconfirmed`, since an error alone does
not prove rollback. An unconfirmed entry does not stop attempts for other entries.
Drive failures are reported separately and do not erase confirmed answers. Observation
can itself fail, so losing the envelope response still requires reconciliation. A
concurrent owner can advance between operations; the envelope does not lock the tree.

The three-file journey returns three named read interactions in one frontier. One
answer envelope supplies their contents and advances every child through its cleanup,
with host-handled release effects requiring no further client turn. Known cleanup denial
returns a new repair wait; unknown delivery stays occupied without automatic retry.
Mixed valid/malformed/stale input preserves successful siblings. Identical retries
reconcile against the original grants after reopen, including after terminal settlement.

`maxIterationsPerHost` is a cooperative limit on each host's loop in this pass, propagated
to children. Zero permits acceptance but no Guest advancement. It is not a global work,
time or memory limit and cannot interrupt stalled handlers or cleanup. Empty frontier
does not imply completion: inspect the report, especially after yielding or occupancy.
This is simulated edge composition, not an HTTP adapter or new framework batch API.

### Retry after terminal settlement

The frontier command assembly reconstructs routes from active owned boundaries,
accepted owned-call receipts and cancellation control boundaries. It reacquires the
recorded children with their pinned definitions, recursively, without executing Guests.
The client supplies no traversal path. Historical answer validation uses the original
interaction registration and accepted outcome; terminal state does not mint new grants
or make revoked input eligible. Authentication/schema policy still applies to duplicates.

A dropped edge response can therefore be retried after all three files and their cleanup
have settled. The envelope reports original receipts with `duplicate: true`, the terminal
result and an empty interaction frontier. Conflicting values, foreign targets and revoked
or unauthorized answers remain unconfirmed entries; successful siblings still reconcile.
The 64-case frontier suite verifies this for completed and cancelled nested trees and
checks unchanged journal revisions, accepted history, activation intent and effect counts.

This router understands this application's owned-group protocol and scans its retained
history in pages. It is not a generic descendant index or a constant-cost lookup. History,
registrations, child links and compatible program/schema bindings must remain available;
pruning and contract-version migration need explicit product policy. No envelope receipt
store, schema migration or new journal primitive was introduced.

## Read-only tree streams

`createJournalTreeStream(owner, root)` observes a known owned execution tree through
`JournalReader`. It returns `Stream<JournalTreeObservation, void, Y>` and acquires no
Guest, installs no result bindings, and performs no journal writes. Subscription itself
performs no reads; each pull observes one node in depth-first preorder, following
persisted child declaration order. It uses one snapshot per node and loads no accepted
history pages. Single-journal presentation shares the same internal state projection.

```ts
const nodes = yield * createJournalTreeStream(runtime.composition, root);
while (true) {
  const item = yield * nodes.next();
  if (item.done) {
    break;
  }
  const { execution, program, parent, state } = item.value;
  // Application: decode by pinned program, authorize and project state.
}
```

Each observation contains execution/program identity, optional parent execution/request
identity, and `JournalPresentationState<unknown, unknown>`. It includes the root and
terminal children still linked by a running parent. It follows active links captured
at each read; it does not enumerate historical ownership after a terminal root.
Historical answer routing remains a separate command assembly.

The stream has one controlling subscription and belongs to the supplied owner. Exit
releases traversal state; escaped subscriptions and concurrent pulls reject under the
existing pull-stream contract. Early exit opens no unvisited children. Open/read errors
fail the stream, so earlier emitted nodes are a partial observation. The caller owns
the storage connection and must create a fresh reader and stream after reopening.

Each node carries its own revision. Completion means captured paths were visited, not
that the tree was observed atomically or is settled. A changing tree can keep exposing
new descendants; no constant memory or bounded traversal time is promised. An empty
interaction projection does not prove completion. Running state does not establish a
live driver, and a read cannot make a yielded branch register its next interaction.

Both the Lua tree-frontier and authored-tool/chat applications now use this stream.
Their schema lookup, role filtering, JSON projection, answer validation, edge envelopes
and historical command routes remain local. The focused suites cover 76 tree cases
across memory/SQLite and both runtimes, plus 16 chat cases. Additional type evidence
checks unknown node payloads and preservation of the runtime yield type.
