# Serialized Guest execution

`createWorkerGuest(runtime, options)` implements Guest over a dedicated MessagePort.
`serveGuestWorker(runtime, options)` acquires and advances the actual Guest in one
remote native scope. Worker creation, program selection and input admission remain
assembly responsibilities. Transfer a dedicated port to a worker and run the server
there; neither a body closure nor host grants are sent through this protocol.

```ts
// Host: own the proxy in the acquisition scope.
const guest = createWorkerGuest(runtime, { incarnation, port, codec, failure, terminate });
yield * runtime.composition.ensure(() => guest.close());
// Supply this acquisition to ordinary journal recovery/hosting.

// Worker: acquire the pinned program/input inside this server's scope.
yield * serveGuestWorker(runtime, { incarnation, port, codec, acquire });
```

Wire commands and responses are internal to this adapter, not execution contracts. Commands carry
an incarnation ID and increasing sequence number. Start/resume/cancel return Turn;
close acknowledges physical Guest disposal. Errors are diagnostics, not authored
Outcome failures. The receiver rejects stale/out-of-order commands before advancement.
Only one command may be outstanding. An arrival while the server is advancing
fences the channel; the overlapping command is never queued for later execution. Each new acquisition must use a fresh channel
and incarnation identity; identities are correlation, not credentials or leases.

Messages are Uint8Array bytes through an explicit matching codec. The codec must
preserve the application's values (including undefined, typed arrays, etc. when used).
There is no implicit JSON conversion. Wire envelope/scope shape is checked; codecs
and the pinned remote program are trusted for payload representation. Domain schemas,
grants, delivery, acceptance and journal publication remain on the host.

Any failed/interrupted exchange, error response or mismatched correlation fences the
proxy. No command is retried on that incarnation. Its owner closes it, forcibly joins
remote physical shutdown via terminate(), then reacquires for journal replay. A lost
resume response may mean the remote computation advanced; it does not authorize
another effect delivery. This adapter does not add automatic host retries or a second
command log. Checkpoint capture/restore over the channel is deferred.

Normal close requests disposal and waits for acknowledgement, then invokes terminate
as the final physical resource barrier. A poisoned proxy skips the uncertain channel
and goes directly to termination. terminate must shut down/join the remote resources
without depending on this port, including when its peer has failed. Repeated close
joins the same termination promise. Logical cancellation uses cancel and may yield
cleanup exchanges; physical close/termination must not run authored cleanup.

A silent disconnected peer cannot be detected by MessagePort itself. Assembly owns
failure detection/deadlines and must abort the required failure signal when it abandons
a reply, including a close acknowledgement. That signal rejects pending exchanges
independently of native interruption, so it also releases uninterruptible scope finalizers
to reach terminate(). Already-aborted signals prevent sending another command. The
adapter does not invent a timeout. The server scope must also be stopped by its
worker owner on transport loss. messageerror is treated as transport failure.

Acceptance uses real in-process MessageChannels and Node V8 byte encoding. It drops
a response after resume, interrupts the host, then reopens SQLite with a fresh proxy.
Accepted effects are not redelivered. It also covers correlated replies, cancellation
and protected cleanup across reopen, disposal acknowledgement and joined remote
scope cleanup. This establishes serialized protocol behavior, not OS-process crash
survival, remote authentication, or worker deployment integration.

The server consumes MessagePort callbacks through a scoped runtime Signal subscription.
Subscription is established before listeners attach, and scope cleanup removes listeners
and releases queued messages. Arrival-time admission owns one outstanding-command slot
through response publication, so stream buffering cannot admit overlapping commands.
Transport failure closes the internal stream and fences the server. The proxy's separate
failure AbortSignal remains responsible for interrupting uncertain exchanges/finalizers;
a broadcast Signal does not replace that retained failure condition. No StreamApi is
needed for this private protocol loop.

The public surface is createWorkerGuest, serveGuestWorker, their options, and the
port/codec contracts supplied by assembly. Callers consume Guest and Turn from
execution. Correlation, command envelopes, response diagnostics, decoding and receiver
state stay internal. Testing faults operate on decoded wire data and may deliberately
inject malformed values; they do not require public production message types.
