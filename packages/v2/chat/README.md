# Chat context assembly

`createChatContext(composition, name)` exposes preparation through the ordinary
scoped `createApi` mechanism. Its default `prepare` driver calls `prepareChatInference`.
Use `around` to compose strategies and `install` to replace the driver within a scope.

```ts
const context = createChatContext(runtime.composition, "chat-context");
yield *
  context.around({
    *prepare([input], next) {
      const history = selectCompletedWindow(input.history);
      return yield* next({ ...input, history });
    },
  });
const inference = yield * context.operations.prepare({ model, history, tools });
```

Here `selectCompletedWindow` is application policy. A strategy can read scoped
contexts, select a window, or apply a summary using the compaction helpers below.
Delegating to `next` retains the default compatibility and complete-tool-group checks;
a replacement driver or short circuit owns its own validation. Middleware and driver
installations follow normal caller-scope inheritance and cleanup. The API introduces
no journal or persistence behavior. Pure helpers remain available for direct use.

`prepareChatInference` prepares a detached model-facing context from accepted history
and an explicit selected model. It returns `{ model: { provider, api, id }, request }`.
Use this entire value as the input of a journaled model effect. Its handler resolves
the pinned selection, consumes the provider stream and returns the complete response.
Provider credentials and executable drivers never enter that input.

```ts
const inference = prepareChatInference({
  model: selectedModelInfo,
  history,
  tools,
  foreignReasoning: "omit",
});
const result = yield * capabilities.sample(inference);
if (result.ok) {
  history.push({ ...result.value.message, model: inference.model });
}
```

Every assistant history entry carries its originating selection. Model identity
compares provider, API and ID; host resolution must pin the underlying configuration.
An alias whose configuration changes is not an immutable model version. The request
selection should be reproducible from accepted conversation inputs. Reading a mutable
"current model" preference inside replay is unsafe: record that decision/input first.
For explicitly selected requests, never silently substitute the latest model in the
delivery handler. The Host-policy pattern below instead selects inside the recorded
sampling exchange and retains that decision in its accepted result. Previously
accepted inference replays without resolving the original provider again.

Switches happen at inference boundaries after all outstanding tool calls have matching
results. Assembly rejects duplicate call IDs, unmatched results and unresolved tool
rounds. It retains tool IDs, names, arguments, error disposition and result order.
Changing the available tools does not erase earlier completed calls/results.

Foreign reasoning rejects by default. Explicit `foreignReasoning: "omit"` removes
foreign reasoning parts (including opaque signatures) and clears foreign tool thought
signatures. Same-model reasoning is preserved. A foreign reasoning-only message is
omitted when no content remains. This changes only the provider view, never accepted
history. It does not assert that all provider transcript formats are interchangeable;
adapters still validate their own format, tool and media restrictions.

Model input modalities, requested reasoning levels and output limits are checked before
dispatch. This is not token counting or compaction. `measureContextBudget` in providers
can assess a count of the resulting request. A future compactor can supply an explicit
summary plus retained history while preserving the original journal. No mutable
conversation store, automatic routing policy or additional runtime primitive is added.

Acceptance extends the existing streaming chat-to-parked-tool journey on both native
runtimes. Model A is recorded in the first accepted sampling result. After SQLite reopen and a
validated tool answer, model B receives the completed history with foreign reasoning
omitted. A is made unavailable before recovery: accepted inference still replays
without dispatch. Terminal recovery repeats neither model. Separate public provider
journeys check compatibility policy, same-model signatures and pre-dispatch rejection.
These use scripted SDK/providers and in-process serialized Guests, not live models.

## Explicit compaction

`prepareChatCompaction(history, through)` selects a detached prefix `[0, through)`.
The current view must be complete, and the cut cannot leave any tool call without
its result. Empty, instruction-only and out-of-range prefixes reject. Boundary
selection is explicit policy; this helper does not choose what facts may be lost.

Journal that request and its generated summary using an installed effect. Summary
generation can itself consume a provider stream in the effect handler; it needs no
special journal mechanism. Validate the response as a nonblank string before
acceptance. If model selection/prompt policy for summarization is dynamic, include
those in the effect input too, following the same pinning rule as normal inference.

```ts
const request = prepareChatCompaction(history, through);
const answer = yield * capabilities.summarize(request);
if (!answer.ok) {
  throw new Error("Summary failed");
}
const view = applyChatCompaction(history, request, answer.value);
const inference = prepareChatInference({ model, history: view, tools });
```

`applyChatCompaction` verifies the exact original prefix (JSON object-key order does
not matter). It returns prefix system/developer instructions unchanged, a labelled
user message containing the summary, then the unchanged suffix. The generated
summary is not promoted to system/developer authority. Original history and journal
entries are never deleted or rewritten. Appended complete suffixes are allowed;
changed prefixes and summaries from another conversation view reject. For repeated
compaction, anchor the next request to the already-compacted view explicitly.

The anchor currently stores the full prefix rather than a hash or revision reference.
This is O(prefix size) storage/comparison and may duplicate journal data. It reduces
model input, not journal size or replay cost. Summary quality and actual token savings
are policy concerns: count the resulting inference request before dispatch. An
execution checkpoint remains a separate mechanism.

Acceptance records a normalized summary, parks the conversation, disables summary
generation and reopens SQLite. Recovery reuses the accepted summary; the next request
contains preserved instructions, that summary and the retained suffix. The original
accepted compaction input/result remain unchanged. Blank summaries and delivery
failures never become accepted history. Additional journeys cover unsafe cuts,
changed prefixes, appended suffixes and repeated compaction through the public API.

API acceptance exercises scoped window policy/context lookup, nested middleware,
replacement drivers, invalid window rejection and default restoration on both runtimes.
The SDK-boundary context journey also prepares through this API before dispatch.

## Guest chat loop

`streamChat(scope, { history, tools, sample })` is the primary
implementation: a single-owner pull stream of `ChatLoopEvent` values ending in a
`ChatLoopResult`. Pass the Guest's logical scope; acquisition registers invalidation
there. It runs sequential model/tool rounds only as the consumer pulls.

```ts
return (
  yield *
  scope.scoped(function* (owner) {
    const events = yield* streamChat(owner, options);
    while (true) {
      const item = yield* events.next();
      if (item.done) {
        return item.value;
      }
      yield* recordProgress(item.value); // Application domain operation.
    }
  })
);
```

`runChat(scope, options)` drains that same stream in a child logical scope and
awaits the optional `event` callback between pulls. It adds no second chat loop.
Omitting the callback drains progress without recording. Consumer failure or early
exit must exit the owning scope; failure outside `next` does not itself poison a
subscription. Duplicate subscriptions and overlapping pulls reject. The terminal
result is available after consuming the final assistant event. Native or UI readers
must not drive this Guest source; hosted activation can own its execution independently.

`sample({ round, history, tools })` yields a recorded domain exchange and returns an
Outcome containing either a sample with model provenance or a sampling-policy denial.
Round is zero-based and comes from the stream, not a mutable middleware counter.
Native scoped APIs must not be yielded directly inside the Guest. The Host chooses
the model, prepares/counts context and invokes the provider through the APIs below.
The loop sequences accepted results; it has no model-selection or round-limit policy.

Each catalog entry pairs model-facing tool metadata with an already-granted
`call` operation. Metadata grants no authority. The loop checks the entire batch's
names and nonempty, unique call IDs before invoking any tool. Input schema validation
remains with each Host handler; this is not atomic validation of all tool inputs.
Tools run in order and may park through existing owned-tool hosting. Applications
format authored failures explicitly as content with `isError: true`; delivery
exceptions propagate without conversion or retry.

Returned history contains the complete logical conversation, correlated tool results
and accepted model provenance. Caller history and progress data are detached. Catalog
and Guest consumption order must remain reproducible across journal replay. This
helper adds no persistence, automatic compaction, parallel tools or session supervisor.
Without sampling middleware there is no built-in round budget.

The streaming chat application now consumes this loop with Host-side preparation
and providers. Additional acceptance journeys exercise multiple calls and rounds,
authored failures, malformed batches, budgets, occupied delivery failures and SQLite
reopen without redispatching accepted work, on both native runtimes. These are
in-process recovery journeys, not process-loss or live-provider tests.

## Assembling authored tools into the catalog

The `chat-provider` acceptance journey now derives model discovery from an authored
`defineTool` through `projectToolContract`. Its small Zod adapter remains local to
the application experiment. No additional scoped API or registry is required:

```ts
const wireInput = z.object({ question: z.string().min(1) });
const confirm = defineTool("confirm")
  .parameters(wireInput.transform(({ question }) => question.trim()).pipe(z.string().min(1)))
  .elicits({ approval })
  .execute(function* (question, ctx) {
    const answer = yield* ctx.elicit("approval", question);
    if (!answer.ok) {
      throw new Error("Approval failed");
    }
    return answer.value;
  });
const contract = projectToolContract(confirm);
const definition = {
  name: contract.id,
  description: "Ask for approval",
  parameters: z.toJSONSchema(contract.context, { io: "input", target: "draft-7" }),
};
```

Build the definition before provider dispatch. The model sees an object containing
`question`; the tool body receives a normalized string. Project the schema's **input**,
not its output. The example rejects unsupported JSON representations such as `Date`
instead of substituting an unconstrained schema. Standard Schema validation alone
supplies no JSON Schema conversion. Even a successful input projection cannot express
all post-transform checks or arbitrary refinements: Host validation remains authoritative.
Provider-specific schema dialect restrictions still belong to the provider adapter.

The catalog entry decodes `call.input` with the same `wireInput` declaration, invokes
`root.capabilities.confirm(decodedInput)`, and explicitly formats the inferred boolean
result as model content. Wire decoding does not run the authored transformation. The
Host grants and routes the original `confirm` object, then validates and persists the
normalized child input before acquisition. The projected contract is discovery data;
do not register it as a second declaration with the same identity. Description and
result formatting remain application choices.

The journey preserves reader-independent execution, participant answers, and SQLite
reopen. It checks that normalization runs once for the accepted child, the completed
result reaches the next model request, and accepted sampling is not redispatched.
Empty wire input and whitespace rejected after normalization never acquire the tool.
Invalid model arguments currently fail this application; automatic corrective model
turns are a separate policy. This evidence uses a scripted provider on both runtimes,
not live model schema conformance, browser imports or process-crash recovery.

## Host model and sampling policy

`createChatModel(composition, name, driver)` exposes `select(request)` through scoped
installation and middleware. `createChatSampling(composition, name, driver)` exposes
`sample(request)` and consumes that model facade's operations internally. Bind one
facade per intended policy boundary; give distinct capabilities distinct names.

```ts
const models = createChatModel(runtime.composition, "chat.selection", {
  *select(request) {
    return request.round === 0 ? planner : responder;
  },
});
const sampling = createChatSampling(runtime.composition, "chat.sampling", {
  model: models.operations,
  *sample(model, request) {
    // Application driver: use context.prepare, counter.count and provider.stream.
    return yield* infer(model, request);
  },
});
yield * sampling.around(limitChatRounds(4));
yield * effects.install(sampleEffect, sampling.operations.sample);
```

`infer` returns `{ model: { provider, api, id }, response }` and may retain additional
accepted metadata such as prepared input and token counts. The default sampling driver
checks returned provenance against the selected model. Replacement drivers and
short-circuit middleware are trusted assembly and own those obligations themselves.
Sampling returns one complete result; live progress remains on the existing provider
stream and independent presentation streams. No second provider stream implementation
is introduced.

`limitChatRounds(maxRounds)` is optional ordinary sampling middleware. Configuration
must be a positive safe integer. It rejects exhausted/invalid rounds before selection
or provider dispatch. After inference on the last allowed round, it rejects a tool
batch before Guest tool invocation, retaining the completed sample in the denial.
A final answer remains allowed. Install it outside caching/short-circuit layers when
it must govern those results as well. Child scopes may add stricter limits; existing
outer middleware still applies. This is trusted policy, not an unbypassable boundary.

Expected denials use `{ ok: false, error: { code, message, sample? } }`. Record that
Outcome through the effect boundary. A denial is not a thrown delivery failure: once
accepted, reopening with a larger limit does not re-run inference or turn it into an
allowed tool batch. The Guest surfaces the recorded denial as failure. Delivery
exceptions still escape unsettled. Unlike the earlier loop-local guard, a denied
sample is retained in the error rather than emitted as normal assistant progress.

An accepted success records the selected model and response. Recovery replays it
without invoking model policy, preparation or providers again; the next unaccepted
inference can see a new scoped policy. Selection is not independently pinned before
sample acceptance. If a decision must survive failed/unaccepted attempts too, pin it
in admitted input or a separate recorded exchange. Never treat this API as permission
to retry uncertain provider delivery. Mutable model aliases also require explicit
configuration/version policy.

Acceptance covers sibling model/limit overrides, restoration, driver replacement,
pre-dispatch rejection, terminal-round success, cancellation during selection,
accepted denial replay under changed limits and streaming-provider reopen under
changed model/preparation policy. These are in-process journeys on both runtimes.

## Recoverable progress

The stream returns detached `ChatLoopEvent` values; the optional runner callback receives
those same values: `assistant`,
`tool-started`, and `tool-completed`. Assistant messages retain model provenance and
all content, including reasoning and media. They are trusted application data, not
automatically safe public UI frames. Apply explicit projection/access policy before
publication.

```ts
*event(event) {
  const accepted = yield* capabilities.progress(event);
  if (!accepted.ok) {
    throw new Error("Progress rejected");
  }
}
```

Here `progress` is an application-defined recorded effect. Its Host handler can
acknowledge the fact without publishing anything. `createJournalPresentation` can
later read accepted progress requests with stable receipts, even when publication
was lost or the next tool is waiting. A client can deduplicate by receipt. This does
not supply a persistent public event store or exactly-once transport.

The callback itself is not intrinsically durable: it runs again during Guest replay.
Direct I/O in it can repeat; yielding a recorded capability makes accepted handling
replay-safe. Adding or removing the callback changes the program's replay contract.
Its failures propagate and prevent subsequent orchestration. Tool start records intent
before calling the tool, not proof of external delivery. Completion follows the tool's
returned authored result; thrown delivery errors emit no completion. Malformed batches
emit no progress; a budget-denied sample produces no normal progress or tool starts. Live provider deltas remain separate provisional output.

Acceptance reopens SQLite while the second tool is waiting, reads the same accepted
progress and receipts without acquiring a Guest, and then resumes without repeating
progress handling. It checks correlated authored failure events and the absence of a
completion event after an occupied delivery failure.

The stream-first ownership registration changes the logical replay contract relative
to older callback-only programs. Pin a new program revision when migrating persisted
executions; do not silently reopen old journals with changed scope boundaries or sampling request/result shapes.

## Authored tool batches and interaction frontiers

The chat-provider acceptance application now connects a two-tool model batch to owned
children: one authored tool requests ordinary approval, while another enters cleanup
and requests repair after an accepted release denial. Tool discovery and interaction
projection use `projectToolContract`; answer validation uses the original declared
elicits through `installEffectAnswers`. Reading the frontier uses `openChild` and
journal presentation, without acquiring tool Guests or installing result bindings.

Batch execution remains an application experiment. `streamChat` invokes callbacks
sequentially. The local sample callback retains the model's validated call descriptors;
the first tool callback yields one recorded owned-batch request. Child hosts run
independently, and the parent receives ordered results only when every child settles.
Later callbacks consume those replay-reconstructed results by call identity. The next
model round receives both correlated tool messages. No new chat API was extracted.

This composition does not turn chat's sequential `tool-started`/`tool-completed` events
into an accurate concurrent execution timeline: the batch can start later tools before
their callbacks are visited. A future batch boundary must specify progress semantics
before promotion. The model-call batch, not UI demand, owns advancement; observation
can discover all already-registered child waits while the batch remains unsettled.

Four additional journeys cover either answer order under both runtimes with SQLite
connection reopen. They verify body/cleanup schema projection, malformed and misrouted
answer rejection, duplicate answers, unchanged sibling grants, delayed next model round,
and no redispatch of accepted model/inspection/release effects. Terminal reopening
acquires no tools. The protocol peer simulates model and resource services; this is not
a production authorization layer, deployed provider test or OS-crash guarantee.
