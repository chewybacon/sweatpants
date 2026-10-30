# Tools

`defineTool` declares an ordinary callable effect with an evaluator-owned body.
Parameter schemas infer caller input and normalized body input; the body infers
its result. Capabilities and typed elicits use existing effect declarations.
Either declaration group can be omitted, and their order is unrestricted.

```ts
const investigate = defineTool("investigate")
  .parameters(querySchema)
  .capabilities({ readFile })
  .elicits({ clarification })
  .execute(function* (input, ctx) {
    const file = yield* ctx.capabilities.readFile(input.path);
    const answer = yield* ctx.elicit("clarification", "Include this file?");
    return { file, answer };
  });
```

`admitTool(runtime, tool, journal, rawInput)` validates a new root invocation and
atomically stores the schema's returned value with the journal's pinned program.
It does not acquire a Guest. Equal normalized resubmissions return the stored value;
conflicting input or program identity rejects, even after completion. Each new
submission validates; recovery instead reads `snapshot.admission.input` without
rerunning the schema. Concurrent validations may both run outside the transaction,
but only one normalized input can win. First admission must precede execution.
Owned children continue to pin input through `ensureChild`.

`createToolAcquisition(runtime, effects, tool, name)` supplies native acquisition
through an ordinary scoped API. Its `operations.acquire(normalizedInput)` creates a
fresh context and recording grant and wraps the body in the scoped evaluator. Input
must already be normalized and pinned by root admission or owned-child acquisition.
No input validation or journal writes occur during acquisition.

```ts
const acquisition = createToolAcquisition(runtime, effects, investigate, "investigate.acquire");
// Recovery consumes persisted normalized input:
const guest = yield * acquisition.operations.acquire(normalizedInput);
// Host assembly uses acquisition.handle and installs acquisition.admission before routing.
// Install effect handlers, participant delivery policy and Guest retention separately.
```

Acquisition grants the tool's declared capabilities, elicits and local recording.
Declarations alone still confer no authority. Capability and elicitation aliases
occupy separate namespaces. `handle` and `admission` resolve the current incarnation's
grant from its owning scope; using them after that scope exits fails. Each incarnation
needs its own scope. Native recorded callbacks require that scope to be retained
through delivery; `installGuestRetention` supplies that hosting policy.

The API supports acquisition middleware for observation and placement selection.
Wrapping `next(input)` preserves the native implementation. Replacing it is trusted
assembly and must provide compatible Guest lifetime and effect delivery; a wrapper
alone does not establish remote placement. The helper does not open journals, install
handlers, mount elicits, route owned calls, validate answers or run a session.

`ctx.scope` owns logical cleanup and critical regions.
`ctx.await(factory, { record: { key: "load" } })` is a convenience over the existing
record sandwich: grant the attempt, execute the Promise through the host runtime,
accept its value, and resume the body. Accepted values replay without executing the
factory. `{ record: {} }` selects positional identity. Unrecorded Promise execution
is deferred. `ctx.record(work, options?)` continues to record explicit outcomes.
Recorded Promise rejection is a delivery error, leaving its attempt unsettled.
Physical disposal discards the body; logical cancellation drains registered cleanup.
Arbitrary native yields and arbitrary finally unwinding on cancellation are not
supported by this evaluator.

The declaration exposes schemas, identity and typed interaction definitions as data,
but also retains executable bodies and possibly server handler dependencies. It is
not a browser-safe bundle projection. Client splitting,
compiler restrictions and checkpointable tool bodies remain future work.

Acceptance journeys invoke tools through granted effects and owned journals on both
native runtimes, including placement middleware, recording, participant answers,
reopen/replay and scope cleanup. Source and emitted-declaration consumers check inference.

Root admission journeys cover invalid input without acquisition, duplicate/conflicting
submissions, transformed input across reopen, and a late validation racing a second
SQLite connection. These are in-process persistence journeys, not OS-crash evidence.
