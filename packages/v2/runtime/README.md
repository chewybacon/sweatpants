# Portable runtime

`Runtime<Y>` owns execution, concurrency, resources and Promise integration.
`runtime.composition` supplies scoped APIs, middleware and contexts. Application
modules import these contracts and remain generic in the yielded protocol `Y`.
Only stack assembly selects `runtime-effect` or `runtime-effection`.

For deciding what to make interceptable, when to use direct wrappers versus scoped
middleware, and what the abstraction does not yet support, read
[Composing behavior](./COMPOSITION.md). Middleware opportunities include synchronous
functions and returned handles, not only asynchronous operations.

`RuntimeType` and `Computation<F, A, E, R>` are structural, type-only mappings from
`@standard-durability/core`, re-exported here. They retain native Effect error and
service slots; Effection tracks its result only. Shared expected failures travel
as explicit Outcome values. The iterator protocol keeps portable workflow bodies
independent of either native implementation.

Both adapters establish fresh composition ownership at start. Child work in all
has isolated bindings; results retain input order and completion awaits cleanup.
A native child failure cancels siblings. A failed Outcome is ordinary data.
Acquisition in using is interruptible. After successful acquisition, release is
registered before use and runs once on completion, failure or cancellation.
Failed or interrupted acquisition owns any partial cleanup itself.

Cancellation requests native interruption and awaits execution and cleanup
settlement. Repeated cancel calls share that barrier; execution or cleanup failure
does not reject cancel. Result remains the failure observation channel.
fromPromise supplies an AbortSignal; callers must
cooperate with cancellation. Native failures, defects and interruption are not
converted into domain Outcome values. Exact native error aggregation and scheduling
are not normalized. There is no journal or persistence implied by this runtime.

Portable asynchronous cleanup uses composition.ensure or runtime.using. Yielding
from JavaScript finally during native interruption is not a portable guarantee.
Native shutdown handles physical resources; durable workflow cancellation and
its logical cleanup require a separate execution protocol.

The hosted lifecycle acceptance journeys exercise pending acquisition cancellation,
release registration before use, and failure reporting while another finalizer
awaits a peer's close reply. Composition journeys cover scoped driver lookup,
middleware ordering, short-circuiting and typed argument/result rewriting under
both adapters. Acquisition-to-use context visibility and null/undefined context
semantics remain unresolved portability boundaries.

The Effect runtime supplies composition and Scope requirements internally. Other
native service requirements must be provided by the stack's operations before
entering this runtime; the HKT retains those requirements and does not erase them.

`withSignal(signal, work)` bounds an externally interruptible child operation.
Already-aborted signals prevent entry. Otherwise native racing interrupts the
child and joins its physical cleanup, preserving inherited composition bindings.
The abort reason is a native failure, not a domain Outcome. Hosting uses this for
optional live-attempt notification; journal invalidation remains a separate commit.

## Streams, channels and signals

`Stream<T, Close, Y>` acquires a subscription whose `next()` returns a value or a
terminal result through operations yielding `Y`. It describes consumption, not a
particular producer. A pull source advances computation on demand; a broadcast
source waits for independently published values. Stream-first is the default for
progress-producing APIs; callback conveniences should drain the same source.

Both runtimes expose the same scoped broadcast implementations:

```ts
const clicks = runtime.createSignal<Event>();
const subscription = yield * clicks;
button.addEventListener("click", clicks.send);
yield *
  runtime.composition.ensure(function* () {
    button.removeEventListener("click", clicks.send);
  });
while (true) {
  const item = yield * subscription.next();
  if (item.done) {
    break;
  }
  console.log(item.value);
}
```

For these Signal/Channel implementations, each subscription independently receives
subsequent publications in FIFO order. Scope
exit unsubscribes, releases buffered values and invalidates that subscription;
cancelling one reader does not close other subscriptions or the producer.

Signal.send is synchronous and safe as an unbound JavaScript callback. Channel.send
is a lazy Operation: `yield* channel.send(value)`. Both broadcast to active subscribers,
with unbounded per-subscription queues and no consumer acknowledgement/backpressure.
Sending with no subscribers drops the event. Values are shared references, not cloned.

Following Effection's broadcast model, close(value) completes current subscriptions
after their buffered values; it does not retain global terminal state for future
subscriptions. Within a completed subscription, the first close wins and subsequent
next calls return the same completion. One subscription permits one outstanding next.
Concurrent reads reject rather than silently dividing that subscriber's events.
An interrupted pending read releases its waiter. If a value has already been handed
to a read when interruption wins, that value may have been consumed; there is no ack.

Use a Signal for callback producers and a Channel for operation producers. Neither
provides retained failure state, durable history, replay, or a work-sharing queue.
Iteration currently uses subscription.next; an each convenience API is not included.
The adapters share createStreams, composed from existing native Promise waiting and
scope cleanup. No extra scheduler, background task or adapter-specific event loop is
introduced. Acceptance runs callback publication, broadcast ordering, closure, scoped
unsubscription and cancellation against Effect and Effection.

## Pull-driven streams

`createPullStream(owner, factory)` constructs a single-use, single-subscriber stream.
The owner supplies `ensure` cleanup registration: use native `runtime.composition`
or a Guest `LogicalScope`. The factory creates a `next` operation at acquisition;
no producer work runs until the consumer pulls. Values return from `next`; yielded
instructions still belong to the operation's native or domain protocol.

```ts
const pages = createPullStream<Page, number, Y, Y>(runtime.composition, () => {
  let cursor = 0;
  return function* next() {
    const page = yield* fetchPage(cursor); // Application operation.
    if (page.done) {
      return { done: true, value: cursor };
    }
    cursor++;
    return { done: false, value: page.value };
  };
});
const reader = yield * pages;
while (true) {
  const item = yield * reader.next();
  if (item.done) {
    return item.value;
  }
  yield * processPage(item.value); // Completes before fetching another page.
}
```

There is no queue, broadcast, acknowledgement protocol or background task. Processing
before the next pull provides sequencing, not durable acknowledgement. Record through
an appropriate domain capability when acceptance must survive recovery.

Acquire and consume inside an owned scope. Exit that scope on early return or consumer
failure; merely breaking a loop while retaining its owner does not invalidate the
reader. Owner cleanup invalidates it. Reacquiring the same stream and overlapping
next calls reject. Repeated reads after normal completion return the terminal result;
thrown iterator failures are retained. Native interruption/failure can bypass generator
catch/finally, so exit the owner rather than attempting to resume a failed native pull.
Source work retains responsibility for its own physical resources and logical cleanup.
The helper does not cancel or join arbitrary work by itself.

Fresh stream instances are independent computations. To let multiple UI readers
observe one execution, drive one source in an application-owned activation and expose
separate broadcast/retained presentation subscriptions. A UI disconnect must not
implicitly dispose that activation. For Guests, host disposal discards the incarnation
without running logical finalizers; subscriptions must never escape that incarnation.
Recovery reconstructs the stream and its consumption order from the pinned program.

`createStreamApi` can decorate this source when its composition understands the same
instructions. Native composition is not a translator for Guest domain instructions.
See [streamChat](../chat/README.md#guest-chat-loop) for a direct Guest stream and callback
runner. Public acceptance covers pull ordering, terminal retention, scoped API wrapping,
duplicate/concurrent access rejection and cancellation invalidation on both runtimes.

## API-backed streams

`createStreamApi(composition, name, defaults)` adds a consumer stream facade to an
ordinary scoped subscription API. Contexts choose the source, APIs provide operation
middleware/installation. The selected source may be pull-driven, a signal/channel,
or a retained stream:

```ts
const Source = runtime.composition.createContext<Stream<Message, void, Y>>("messages.source");
const messages = createStreamApi(runtime.composition, "messages", {
  *subscribe() {
    const source = yield* Source.expect();
    return yield* source;
  },
});
yield * Source.set(workerMessages);
yield *
  messages.around({
    operations: {
      subscribe: (next) =>
        function* (...args) {
          const subscription = yield* next(...args);
          return subscription;
        },
    },
  });
const subscription = yield * messages.stream;
```

Every subscription resolves the API in its executing scope, including a captured
stream facade used later in a child scope. A child may set a different source or
install a replacement subscribe driver; scope exit restores the inherited behavior.
Existing subscriptions stay attached to their original source and lifetime.

Subscription middleware runs once per subscription. To observe/transform individual
events, wrap the returned subscription.next operation and preserve its completion
value. The facade does not automatically install middleware around event delivery.
A middleware-created child scope cannot return a subscription that outlives that scope.
Synchronous signal publication does not dispatch through this subscription API.

The adapter creates no context, queue, task or additional lifetime. Application
assembly owns contexts and producer selection; consumers can receive only stream.
Acceptance verifies scoped source selection, driver replacement/restoration, event
transformation, completion values, and disposed child subscription rejection on both
runtimes. Type consumers verify inferred message, completion and yield types.

## Retained callback streams

`createBufferedSignal<T, Close, Y>(runtime)` implements the same callback-facing
send/close and operation-facing subscription shape as Signal, but retains values
without subscribers and retains terminal completion or failure for future readers.

```ts
const output = createBufferedSignal<string, string, Y>(runtime);
output.send("first"); // Retained even before the first subscription.
const reader = yield * output;
const first = yield * reader.next();
// A later reader supplies the count of values it has already consumed.
const resumed = yield * output.from(1);
output.send("second");
output.close("parked");
```

Each reader owns an independent cursor. Its scope exit removes its notification
subscription, without cancelling production or deleting history. Values drain before
completion or failure; `fail(error)` retains the error and each reader throws when
it reaches the tail. First close/failure wins; send after terminal throws. Offsets
must be safe integers between zero and the current tail when subscribing.

This primitive creates no producer task. Host assembly owns and drives the producer
in a scope independent of each client reader. It can append live activity while an
engine's next operation is still pending, then append the returned presentation
values and close when that activation parks or completes. Disconnect is reader
scope disposal, not durable cancellation or Host shutdown.

The buffer stores references in memory without pruning or backpressure. Its owner
must bound its lifetime and avoid mutating published values. It is neither a durable
journal nor a persistent response store, and has no cross-process writer fencing.
Cursor offsets are local to this buffer instance. A live Signal remains appropriate
when only currently subscribed readers should receive events.

Acceptance covers detached readers, production with no subscribers, independent
cursors, reconnect after completion/failure, and physical reader cancellation on
both runtimes. Notifications use coalesced live signals; retained state determines
what a reader observes.

A buffered reader can compact adjacent compatible values at pull time:

```ts
const reader =
  yield *
  output.from(lastOffset, (previous, next) =>
    previous.type === "text" && next.type === "text" && previous.messageId === next.messageId
      ? { ...previous, delta: previous.delta + next.delta }
      : undefined,
  );
const frame = yield * reader.next();
const resumeOffset = reader.offset;
```

The callback must be pure and must not mutate either argument. Returning undefined
leaves the next value for a later frame. Each pull snapshots the available tail and consumes at most 256 source values
by default. `buffer.from(after, compact, maxValues)` selects a different positive
safe-integer limit. It merges only adjacent compatible values and never waits to
accumulate a larger frame. This bounds the number of inputs processed, not the cost
of arbitrary callback code or the payload size of an individual input. Structural events and different message/tool identities should form boundaries.
No AG-UI-specific merging policy is built into runtime.

Offsets always count original source values, not delivered frames. Save the reader's
offset after handling a frame; do not increment a reconnect cursor by one per frame.
Compaction leaves shared history and other readers untouched. A throwing callback
leaves this reader's cursor unchanged. Terminal state is observed only after all
retained values have been returned.

For transport delivery, capture `reader.offset` together with each returned value
as a frame such as `{ value, after }`. A later read must not change the cursor
associated with an already queued or serialized frame. Keep executable compaction
policy in the local implementation; reconnect requests need only source identity
and an offset. Application subscription middleware can trace or authorize the request
without exposing the merger as an argument.
