# AG-UI run projection

`createAgUiRun(runtime, options)` projects one explicitly owned command attempt into
AG-UI run, assistant-text and custom events. It is the supported subset extracted
from yo-chat-v2, not a complete AG-UI protocol implementation or an agent loop.

```ts
const run = createAgUiRun(runtime, {
  threadId,
  errorMessage: "Request failed; accepted progress may remain.",
  *execute(publish) {
    // Application owns commands, storage, sampling and disclosure policy.
    const view = yield* executeCommand(publish.text);
    publish.endText();
    publish.custom("public-view", view);
    return view;
  },
});
const owner = runtime.start(() => run.run());
const body = createReadableStream(runtime, run.events());
```

Construction starts no work. `run` is single-use and owns a scope that joins resource
cleanup before returning. The caller owns the producer task and cancellation.
Readers are independent: subscribing, slowing down or disconnecting does not start,
stall or cancel execution. An HTTP route may explicitly connect request cancellation
to owner cancellation. SSE encoding remains a transport adapter responsibility.

`RUN_FINISHED` means this attempt returned. A durable turn may still be parked for
input. It says nothing about objective completion. Another command can advance that
turn through a new run. Errors propagate to the owner and publish only the selected
public error message. Native interruption closes readers after joined cleanup and
must not be interpreted as durable cancellation or safe retry authority. A pre-aborted
signal starts no execution. Late publisher calls after completion/disposal are ignored.

`text` accepts cumulative provisional text: matching prefixes emit only the delta;
a replacement closes the old message and opens a new one. `endText` closes it
explicitly, and terminal success/failure closes any remaining text. `custom` publishes
an application-selected public value. Values are cloned at publication and per reader;
they must be structured-cloneable. This prevents mutation between readers, but is not
redaction or authorization. Provisional text is not an accepted journal outcome.

Events are retained in memory for the lifetime of the run object. `events(offset)`
counts source events in that object, not durable journal positions or HTTP resume
tokens. Retention is unbounded within the attempt; hosts must bound attempt lifetime
and output and release old run objects. Durable reconstruction belongs to the journal
presentation/application layer. No registry, background scheduler, public event store,
client acknowledgement store or cross-process notification transport is supplied.

The execute operation and public error text are construction-selected host policy.
It can invoke existing scoped capabilities and middleware. This adapter does not
select continuation, assessment, budgets or what the application considers complete.

The actual yo-chat-v2 card, flight and code wrappers use this adapter. Acceptance
covers independent readers, offset resume, database reconstruction, parked results,
text replacement, error disclosure, cancellation, joined cleanup and late callbacks
on both native runtimes. These are in-process tests, not deployment evidence.
