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
Never silently substitute the latest model in the delivery handler. Previously
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
runtimes. Model A is recorded in the first accepted request. After SQLite reopen and a
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
