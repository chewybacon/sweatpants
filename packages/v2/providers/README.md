# Model providers

`ModelProvider<Request, Event, Response, Y>` describes one scoped inference stream.
Install it using the runtime's ordinary `composition.createApi`; middleware wraps
`stream(request)` at subscription time and may wrap the returned subscription to
observe events. Request selection can use ordinary scoped contexts.

A subscription starts one request and owns its physical lifetime. Partial events
are provisional. The terminal response is complete provider output, which hosting
may subsequently validate and accept into a journal. Exceptions and cancellation
must not fabricate a successful terminal response. Repeating a subscription starts
another request; this is not a broadcast source or a durable response log.

The contract deliberately keeps request/event/response types supplied by the
consumer while the first chat tracer establishes the needed vocabulary. There is
no universal message schema, provider SDK, automatic retry, or HTTP endpoint yet.
A granted sample effect and a chat model iteration can use the same provider API;
provider implementations know nothing about journals or tool execution.

The chat acceptance tracer composes a journaled model effect with an owned tool.
It consumes the provider stream inside a child scope, joins provider cleanup, and
returns the complete response for effect validation and journal acceptance. The
tool parks on a participant wait. SQLite reopen reconstructs the parent and child
through serialized local Guest placement without invoking the accepted model
request again. A validated answer completes the tool and supplies a correlated
result to the next model request. Live events are not replayed.

Separate journeys stop after partial output by provider failure or physical
cancellation: cleanup is joined and no response is accepted. These tests use a
scripted provider, in-process byte transport and SQLite reopen. They do not cover
an external provider's wire format, OS-worker deployment, HTTP response streaming,
conversation command admission or a general multi-tool chat loop.

The tracer also exercises ProgramDriver's independent production and delivery pattern:
Host activation eagerly consumes inference, appending live text to a buffered signal
while its advancement is pending. A separately scoped client reads one event and
cancels its pending read. The model is not aborted; with no readers present, the Host
consumes the rest, accepts the response and drives the owned tool to an elicitation.
After activation cleanup joins, it appends the elicitation presentation and closes
that response buffer. A new reader resumes from its offset and drains the remainder.
Provider failure and Host cancellation retain partial output followed by failure,
without accepting a model response. Client disconnect and Host cancellation therefore
exercise different ownership boundaries.

This uses separate native executions for Host and client under test-owned cleanup.
It does not introduce a production session supervisor or extend the buffer lifetime
across process loss. Journal reopen and reconnect to a retained in-memory response
buffer remain distinct operations.

Client subscription in the tracer goes through an ordinary scoped API:
`subscribe({ after })`. A context selects the retained source; the implementation
binds the output protocol's compaction policy. Middleware traces subscriptions and
delegates without adding a callback to reconnect input. Each returned value is a
frame `{ value, after }`: its source offset is captured before another read can
advance the reader. A queued or serialized frame therefore retains its own resume
cursor. Each client installs the source and middleware in its own scope; the API
facade retains neither after scope exit. Delegation stays in the caller's scope so
the subscription remains live for that client. No parallel BufferedStreamApi or
generalized StreamApi change is needed.
