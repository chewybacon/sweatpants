# Portable runtime

`Runtime<Y>` owns execution, concurrency, resources and Promise integration.
`runtime.composition` supplies scoped APIs, middleware and contexts. Application
modules import these contracts and remain generic in the yielded protocol `Y`.
Only stack assembly selects `runtime-effect` or `runtime-effection`.

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

Both runtimes expose the same scoped broadcast primitives:

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

A Stream is an Operation that acquires a Subscription in the current scope. Each
subscription independently receives subsequent publications in FIFO order. Scope
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

## API-backed streams

`createStreamApi(composition, name, defaults)` adds a consumer stream facade to an
ordinary scoped subscription API. Contexts choose the source, APIs provide operation
middleware/installation, and signals/channels remain the publishing endpoints:

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
    *subscribe(args, next) {
      const subscription = yield* next(...args);
      return subscription;
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
