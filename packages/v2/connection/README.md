# Scope-owned connections

`yield* createConnection(runtime, options)` acquires one physical conversation over
an ordered byte Transport and matching WireCodec. The caller's scope owns listeners
and the private incoming stream subscription. Both endpoints use the same primitive.

```ts
const peer = yield * createConnection(runtime, { transport, codec, failure });
const answer = yield * peer.exchange(request);

// A separate consumer can handle reverse requests while exchange awaits its reply.
const incoming = yield * peer.receive();
const answerToPeer = yield * handler.operations.handle(incoming.value);
yield * incoming.respond(answerToPeer);
```

These snippets describe separate concurrent operations, not a sequential reverse-call
loop. `receive` has one consumer at a time. Assembly owns handler scheduling: it may
consume and reply sequentially, or dispatch received requests into owned concurrent
work. A handler awaiting a reverse call must leave a consumer available if further
nested calls are allowed. The connection never starts detached handlers or installs
a middleware/context system. Ordinary scoped APIs supply those boundaries; the
consumer invokes their operations in its own scope.

Transport supplies postMessage, message/messageerror callbacks, start and close.
Messages contain bytes only. The codec must preserve the application's values;
there is no implicit JSON conversion. Request/reply frames, monotonically increasing
IDs, pending maps and dispatch bookkeeping are internal. Connection validates its
own envelope; application protocols validate the unknown payload. `respond` carries
ordinary values, including authored failure Outcomes. `reject` carries a delivery
error diagnostic. Each incoming exchange can be answered once.

Incoming requests use a private Signal/Subscription established before listeners
attach. Replies resolve the correlated operation directly. Outbound requests do not
block incoming admission. `maxIncoming` bounds unanswered incoming requests, including
queued ones; overflow closes the connection, it does not apply backpressure. Zero
rejects all incoming requests. The default is unbounded. Every reply releases a slot.
The dedicated Guest server uses one slot and retains its own incarnation/order checks.

Assembly must supply a failure AbortSignal for disconnect/deadline policy; MessagePort
alone cannot report every abandoned reply. The signal rejects pending exchanges even
during uninterruptible finalization. Malformed, duplicate/out-of-order requests,
unmatched replies, transport failure, or interrupted outbound exchanges close the
connection. Delivery diagnostic replies reject only their corresponding exchange.
No exchange is automatically retried: remote work may already have happened.

Scope exit or close releases listeners/transport and rejects pending replies. Scope
exit also releases the subscription and its queue. The retained connection.failure
signal lets consumers interrupt their own work. Connection close does not join those
handlers or remote resources; the owning scope/assembly must do that. Application
protocols can acknowledge shutdown before closing; the worker adapter does so and
then joins its independent termination barrier.

This is a live conversation primitive. Durable request/response handoff still belongs
to hosting/journal assembly: return the pending interaction, release the request, and
resume on a later request. No authentication, grants, replay, reconnection, automatic
retries, remote references, notification protocol or journal is added here.

Acceptance covers scoped handler context/middleware, nested reverse calls in both
directions, single replies, transport versus authored failures, and disconnect with
both peers awaiting replies. Worker and reverse-capability journeys use this same
implementation, including lost disposal acknowledgement and journal reopen after
acceptance. All transport evidence is in-process byte delivery, not deployed workers,
HTTP/WebSocket servers, cross-process crashes or network durability.

`createLocalTransport()` supplies the default in-process pair without a native port or
worker. It copies bytes at send time, buffers before start, and delivers on microtasks.
It deliberately shares neither application object references nor synchronous call stacks.
The same connection conformance journeys also run over MessageChannel; hosted behavioral
journeys use the local pair and targeted worker faults retain the MessageChannel adapter.
