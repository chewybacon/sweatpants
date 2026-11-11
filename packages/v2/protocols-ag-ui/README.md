# AG-UI run projection

`createAgUiViewRun(runtime, options)` composes one explicitly owned command attempt
with public-view publication and pending-question interrupts. Applications return
their public view and select public pending questions; they do not construct AG-UI
custom events or terminal outcomes. This assembly uses `createAgUiRun`, the lower
level run/text/custom adapter extracted from yo-chat-v2. Neither implements the
complete AG-UI protocol or an agent loop.

`AgUiRunEvent<V>` uses the official `@ag-ui/core` 1.0.4 event types for this subset,
with assistant-only text starts and a typed custom-event payload. Emitted events use
the official `EventType` constants and are assignable to `AGUIEvent`. Acceptance
validates emitted events against the official schemas.

```ts
const run = createAgUiViewRun(runtime, {
  threadId,
  viewEvent: "public-view",
  errorMessage: "Request failed; accepted progress may remain.",
  pendingQuestions: (view) => view.questions.filter((question) => question.state === "open"),
  *execute(text: (snapshot: string) => void) {
    // Application owns commands, storage, sampling and disclosure policy.
    return yield* executeCommand(text);
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

The view assembly closes provisional text and publishes the returned view under
`viewEvent`. After command cleanup joins, its optional `pendingQuestions(view)`
selects the public pending objects. Each must have an `id`; the complete selected
object is published as `metadata["sweatpants/question"]` on an interrupt with reason
`input_required`. Omit the selector or return an empty iterable for a plain finish.
View layout, pending-state vocabulary, public data selection and answer targets
belong to the application. This is snapshot selection, not journal traversal: do
not pass raw `ToolInteraction` objects containing executable declarations.

`createAgUiViewRun` adds no producer, scope or buffer. It delegates to
`createAgUiRun`, retaining its lifetime, cancellation, cloning and error behavior.
The returned owner result and custom-event payload retain the public view's type.
The example annotates the generator's text parameter so TypeScript can infer the
view even when the dependent selector appears first. When the view is already
named, supplying `<View, Y>` explicitly is also supported, as in yo-chat-v2.
The lower-level adapter remains available when applications need to publish their
own custom events or choose a different terminal outcome policy.

On the lower-level adapter, optional `outcome(result)` synchronously projects a successful command result into
the official `RunFinishedEvent["outcome"]`, after command cleanup joins. It can
return `{ type: "interrupt", interrupts }` for public pending questions. Omit it or
return `undefined` to keep a plain attempt finish. The adapter clones this value
before publication and per reader. Projection or cloning failures publish the public
`RUN_ERROR` and propagate the original error to the owner. Execution, cleanup and
cancellation failures never invoke the projection.

The demo selects every open, answerable public question from its view. The assembly
projects them into interrupts using their public IDs. The question metadata retains
the existing root, execution, grant, effect and public input. Answered, blocked and
cancelled questions are excluded; no interrupt outcome is emitted for an empty list.
Reconnecting reconstructs these questions from durable state. The custom view stays
available for the demo UI. Applications still own authentication, answer validation,
interaction discovery and command routing; AG-UI resume input is not implemented.

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

The execute operation, question selection, lower-level outcome projection and public
error text are construction-selected host policy. Execution can invoke existing
scoped capabilities and middleware. This adapter does not
select continuation, assessment, budgets or what the application considers complete.

The actual yo-chat-v2 card, flight and code wrappers use the public-view assembly.
An independent document-approval view exercises its inferred types, text/view event
ordering, optional question selection and selection after cleanup. Acceptance also
covers independent readers, offset resume, database reconstruction, parked results,
text replacement, error disclosure, cancellation, joined cleanup and late callbacks
on both native runtimes. These are in-process tests, not deployment evidence.
