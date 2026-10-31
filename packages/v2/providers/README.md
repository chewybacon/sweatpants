# Model providers

`ModelProvider<Y>` describes one scoped inference stream using the canonical
`ModelRequest`, `ModelStreamEvent` and `ModelResponse` vocabulary ported from v1.
Install it using the runtime's ordinary `composition.createApi`; middleware wraps
`stream(request)` at subscription time and may wrap the returned subscription to
observe events. Request selection can use ordinary scoped contexts.

A subscription starts one request and owns its physical lifetime. Partial events
are provisional. The terminal response is complete provider output, which hosting
may subsequently validate and accept into a journal. Exceptions and cancellation
must not fabricate a successful terminal response. Repeating a subscription starts
another request; this is not a broadcast source or a durable response log.

The portable request contains context (messages and tool declarations) plus generation
options. Provider selection, credentials, endpoint configuration and abort wiring
belong to the host/adapter assembly. A production host must pin model selection as
part of its durable invocation identity; the tracer uses one fixed scripted model.
The generic parameters after Y allow an adapter-specific request/event/response
contract where needed, without changing stream lifetime semantics.

The data vocabulary preserves v1's content sources and modalities, system/developer/
user/assistant/tool roles, reasoning signatures, tool-call identity, usage/cost,
response provenance, and text/reasoning/tool-call stream events. Types do not establish
provider support for every modality. This slice ports no legacy runtime dependencies,
provider SDK, authentication, automatic retry, or HTTP endpoint. Production decoders
and their payload-size/modality checks remain to be ported with an adapter; the tracer
uses Standard Schema validation for its scripted exchanges.

A granted sample effect and a chat model iteration can use the same provider API;
provider implementations know nothing about journals or tool execution. The tracer
turns an error event or terminal errorMessage into a delivery error before acceptance.

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

Model limits and accounting remain separate from execution. `ModelInfo` is safe data
for display and planning. `measureContextBudget(info, { tokens, kind }, reservedOutput)`
computes remaining context from a count of the exact next request, including tools
and media. `kind` preserves measured versus estimated counts. Unknown limits produce
unknown fit; exceeding a known limit produces false. Output reservations also respect
the model output cap. No tokenizer, automatic truncation, summarization, cumulative
billing store or enforcement middleware is installed by this helper. A previous
response's total usage is not a count of the next prompt.

Usage preserves reasoning and cache-write breakdowns without double counting, and
unreported values remain unknown. Costs are reported adapter/SDK costs rather than
an invoice guarantee. A host can aggregate accepted responses for conversation usage;
billing for failed/unaccepted attempts requires separate operational telemetry.

`ImageProvider.generate` is a separate scoped operation using text/image input and
complete image output, preserving the same physical cancellation and host-owned
journal boundary. Voice APIs are deferred; audio remains a canonical content type
that individual adapters may reject explicitly.
