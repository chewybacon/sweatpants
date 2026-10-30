# Serialized Guest execution

`yield* createWorkerGuest(runtime, options)` acquires a Guest proxy and its connection
in the invoking scope.
`serveGuestWorker(runtime, options)` acquires and advances the actual Guest in one
remote native scope. Worker creation, program selection and input admission remain
assembly responsibilities. Transfer a dedicated port to a worker and run the server
there; neither a body closure nor host grants are sent through this protocol.

```ts
// Host: own the proxy in the acquisition scope.
const guest = yield * createWorkerGuest(runtime, { incarnation, port, codec, failure, terminate });
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
command log. Checkpoint capture/restore uses the same connection when the evaluator supplies it.

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

Both endpoints use @sweatpan.ts/connection for transport listeners, stream ingress,
request/reply correlation, decoding of connection frames and pending-reply failure.
The server admits at most one unanswered incoming request, including queued requests;
the proxy rejects incoming calls. Guest incarnation/sequence checks remain local to
this adapter. A successful advancement replies with Turn directly; successful close
replies with undefined. Delivery exceptions use the connection's diagnostic reply.
There is no second GuestResponse envelope or correlation layer in the reply.

The public surface includes the proxy/server and local/worker assembly factories with their options. Assembly
imports Transport and WireCodec from connection. Callers consume Guest and Turn from
execution. Guest commands and receiver state stay internal. Testing faults operate
on wire data and may deliberately inject malformed values. Wire compatibility with
the previous experimental adapter is intentionally not preserved.

Acquisition registers the termination barrier before opening the connection, so a
failed acquisition also joins the remote resources. Normal owners still register
Guest.close to request acknowledged disposal before scope exit. Termination is joined
once, including after connection failure or unsuccessful acquisition.

## Default local placement and checkpoints

`createLocalExecution(runtime, { acquire, codec, checkpoints? })` is the standard
in-process hosted assembly. It uses createLocalTransport and exactly the same connection,
proxy and receiver as worker placement. Bytes are copied on send and delivered on a
microtask. The codec still serializes application values. The server has its own native
scope; it does not implicitly inherit host handlers, contexts or authority.

```ts
const local = createLocalExecution(runtime, {
  acquire: evaluator.acquire,
  checkpoints: evaluator.checkpoints,
  codec,
});
const recovery = createRecovery(runtime.composition, {
  name,
  program,
  acquire: local.acquire,
  matches,
});
if (local.checkpoints) {
  yield *
    recovery.around(
      createCheckpointMiddleware({
        program,
        execution: recovery.execution,
        adapter: local.checkpoints,
        matches,
      }),
    );
}
```

`createWorkerExecution(runtime, { open })` supplies replay-only acquisition over
caller-provided remote placement; its `checkpoints` is undefined. Supplying
`checkpointFormat` explicitly enables the checkpoint adapter and requires a matching
server-side evaluator adapter. Every acquisition/restore
calls open for fresh transport and incarnation. Its adapter recognizes only its own
proxies; capturing an unrelated Guest returns undefined.

Capture and restore are internal protocol commands. The server checks the pinned
adapter format, then invokes the evaluator's checkpoint capability. It lazily acquires
on start or restores on the first restore command: restoration never starts a fresh
program or overwrites a live Guest. Capture returns serialized state; restore returns
the restored Turn. The existing recovery middleware validates the journal anchor and
reconciles accepted history after that boundary. Unsupported saved formats still select
ordinary replay before acquisition; supported restore failures propagate. Cancellation
continues to select replay according to existing recovery policy.

`resume(outcome)` advances a live Guest with an answer. Journal replay also uses it:
a fresh Guest starts from the beginning and consumes accepted answers without repeating
external work. It does not require a checkpoint or restoration of an old incarnation.

Checkpoint policy remains middleware; representation and restoration remain optional evaluator
capabilities. Connection and transport do not know journal positions or checkpoint policy.

For native tool bodies whose recorded callbacks are installed locally, invoke the
original tool acquisition in the host scope first, then supply that Guest to local
placement. Retain that host scope through delivery. This intentionally local binding
assembly does not make callback closures deployable across processes. A remote placement
must assemble its own pinned program/capabilities; no closure crosses the byte transport.
