# Hosted chat execution

## Recorded chat programs

`defineChatProgram` supplies the ordinary recorded sampling/tool-batch protocol so an
application can declare its history and formatting policies without writing effects,
nested transport Outcomes or positional call/result correlation:

```ts
const program = defineChatProgram({
  id: "file-chat-v2",
  history(admitted) {
    return [{ role: "user", content: chatInput.parse(admitted).prompt }];
  },
  toolResult(value) {
    return { content: z.string().parse(value), isError: false };
  },
  result(completed) {
    return completed.response.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  },
});

// Persist program.id when creating/admitting the journal.
const chat = program.bind(runtime, { journal, tools, sampling, recovery, matches });
const report = yield * chat.run();
```

The complete [file-chat application](../acceptance/examples/file-chat.ts) uses this
surface. Its one-question, ten-question and asymmetric body/cleanup journeys all use
the same declaration and binding recipe.

Declaration is immutable and starts no work. `program.id` includes the framework
protocol suffix `/recorded-chat/v1`; it is the identity to persist, not just the
application ID passed to the factory. The sampling and tool effects derive their IDs
from that full identity. Changing application projections, catalog meaning or other
replay behavior requires a new application ID. Future framework protocol changes need
a new protocol revision. This does not migrate earlier custom chat journals.

Binding delegates to `createChatExecution`. It installs sampling on the same effect
grant used by the generated Guest, records the complete accepted sampling outcome,
and sends model tool calls through owned sibling execution. It verifies result count,
formats each tool value with `toolResult(value, call)`, assigns the original call ID,
and leaves final result-set checks to the existing chat loop. It does not implement a
second loop or a scheduler. Tool formatting may explicitly return `isError: true`;
delivery exceptions do not become fabricated model tool results.

Fresh Guest acquisition requires admission and passes its persisted input to `history`.
The callbacks are synchronous, pure application projections: do not load mutable client
state, perform side effects or depend on changing provider policy inside them. Tool
formatting and final projection can run again during replay. Already-accepted work is
not rolled back when a projection throws. Return the whole `completed` value to retain
`ChatLoopResult` instead of a text response; its inferred result type is retained by
the bound execution and journal.

Sampling remains the existing typed `ChatSampling` capability. The internal schemas
check local envelopes: round/arrays, nonempty model identity and assistant content
array, batch identities and result arrays. They are not a complete provider message,
media, JSON or security validator. The sampling adapter must decode external input
and honor its typed contract. A malformed success envelope fails before journal
acceptance and leaves uncertain delivery occupied. An expected sampling denial is
accepted as data; the current chat loop then throws its diagnostic. Reopen replays
that denial without another provider call. Neither behavior introduces a durable
failed-terminal state.

Optional `bind` configuration receives the root Host for existing continuation/retry
policies. Child policies belong to the tool bindings. This protocol drains `streamChat`
through `runChat` without recording separate progress effects. For a custom recorded
progress or sampling/batch protocol, use the lower-level binding below and a distinct
program identity. There is no hidden UI stream or client-session lifetime.

## Custom execution bindings

`createChatExecution(runtime, options)` binds one open root journal, its pinned
Guest program and one tool catalog. It exposes independent `run`, `answer` and
`interactions` operations. It constructs no task or Guest until invoked. The
portable chat loop remains in `@sweatpan.ts/chat`; importing that package does not
import this server assembly.

```ts
const approval = createChatToolBinding(runtime, approvalTool, {
  definition: approvalModelMetadata,
  recovery: makeRecovery,
  matches: equalRequests,
  *configure({ host, effects }) {
    // Install this tool's native capability handlers and optional policies.
    yield* effects.install(inspect, inspectHandler);
    yield* host.around(continuationPolicy());
  },
});

const execution = createChatExecution(runtime, {
  name: "chat",
  program: pinnedProgram,
  journal,
  effects: { sample, batch, progress },
  tools: [approval],
  recovery: makeRecovery,
  matches: equalRequests,
  acquire: acquireChatProgram,
  batch: {
    effect: batch.id,
    calls: decodeBatchCalls,
    outcome: projectBatchResult,
  },
  configure: installChatHandlers,
});

const report = yield * execution.run();
const questions = yield * execution.interactions();
const question = yield * questions.next();
// A separate authorized invocation may submit an authored success or failure.
const receipt = yield * execution.answer(target, { ok: true, value: answer });
```

The root program's `acquire(grant, definitions)` receives the exact effect grant used
by the root Host and model metadata from the bound catalog. It authors the Guest using
`streamChat`/`runChat` and domain effects. Native provider/sampling implementations are
installed through `configure`; they must not be yielded directly by the Guest. The
assembly does not invent schemas, effect IDs, a journal protocol or a new chat loop.
Its generic root result preserves the pinned program's existing result shape.

`batch.calls` decodes the program's pending batch into model names and raw inputs.
The assembly resolves all names and validates all new inputs before creating children.
Each tool's original context schema supplies normalized input; reopen uses persisted
input without reapplying transforms. The sibling projection returns results in call
order through the supplied pure `batch.outcome`. The Guest remains responsible for
correlating these results to model call IDs through the existing chat batch contract.
Validation is not a transaction over external effects or a guarantee that concurrent
first submissions run schema code exactly once.

The tool binding captures normalized input and result inference before heterogeneous
catalog storage. It owns fresh effect capabilities, acquisition, recovery and Hosting
for each child run. It installs grant admission, per-run Guest retention and default
participant routing. `configure` receives these same instances; policy can wrap them
using their existing middleware APIs. It is trusted assembly code and can deliberately
short-circuit middleware. Required wiring is not an optional installation left to callers.

## Ownership and placement

Each `run` executes inside a fresh native child scope, advances sibling tools using
structured concurrency and joins cleanup before returning. Root and child continuations
must be configured separately if both need budgets. Budgets are cooperative; no timeout,
hard isolation, retry, scheduling or durable cancellation is implied. A returned child
report is a scheduling summary, not a complete inventory of questions.

`recovery` is an explicit generic factory taking program, request equality and Guest
acquisition. It can wrap `createRecovery` with the application's existing local or
worker placement. It must preserve those supplied semantics and own acquired resources.
This package imports no concrete runtime, database, codec or testing helper. The migrated
acceptance consumer retains its serialized Guest placement rather than switching to
direct execution.

Construction is pure and connection-bound, rather than scoped: middleware is installed
inside each run's scope. Rebuild the binding after closing/reopening storage. `run`,
`answer` and discovery check the configured root program. A factory is trusted local
wiring, not an authorization credential or an admission operation. The caller supplies
compatible executable code and replay-stable input. If the application requires root
admission, verify admission and use its persisted input before acquisition; the assembly
also supports existing programs without an admission record.

Tool IDs are persisted program identities. Version them when their authored semantics
change; a model-facing name may differ. Keep the catalog, declarations and supplied
program recipe stable for the lifetime of this binding. A string identity check cannot
prove executable compatibility. This first catalog accepts one model name per program.

## Answers and discovery

`answer` verifies persisted descendant ownership under this root, resolves the stored
program and exact request, then validates the original elicitation response contract.
It does not acquire a Guest, enumerate the frontier or recreate result projections.
Journal ingress rechecks the grant after validation. Duplicate/conflicting answers
retain the journal's existing behavior, including after terminal settlement.

`ChatAnswerValidationError` identifies failure before this invocation submitted to
journal answer ingress; its `cause` retains the original error. It does not establish
that an earlier invocation or another writer never accepted the grant. Other exceptions
remain unclassified. The application owns public error projection and whether a client
may correct an answer. An answer receipt does not imply any later drive succeeded.

`interactions()` produces a fresh read-only pull stream over the same catalog. Its
subscription belongs to the acquiring native scope and cannot escape that scope.
It discovers registered body and cleanup questions without running code. Entries retain
local scope/cancellation facts and raw declarations; filter visibility and encode them
before exposing them remotely. Snapshots are separate, not one atomic frontier. Missing
contracts fail discovery; an empty stream is not proof of execution completion.

There is no combined edge envelope or client cache here. Applications can independently
accept answers, drive, and read discovery, preserving each phase's observations and
partial failures. Provider progress callbacks are not durable notifications. Admission,
HTTP, authentication, conversation history storage and client correction policy remain
application responsibilities.

## Evidence

The chat-provider batch journey runs this assembly under both native runtimes with
SQLite and serialized Guests. It covers body/cleanup waits, asymmetric answers, partial
acceptance/correction, lost responses, occupied effects, terminal reopen and unchanged
provider delivery. It also exercises distinct normalized tool inputs, one transform
across reopen, wrong-program rejection, stale connection handles and escaped discovery
subscriptions. Physical owner cancellation joins both in-flight tool deliveries; reopen
preserves occupied attempts without redispatch. Type fixtures check heterogeneous tool
results against source and emitted declarations. These are in-process protocol/reopen
journeys, not live provider, OS-crash or deployment guarantees.
