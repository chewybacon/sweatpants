# yo-tisyn: timeboxed binding spike

**Status: sequential durable workflows, including guarded loops. Not a finished app or a security sandbox.**

Tisyn drives existing Sweatpants durable tools without importing Tisyn's runtime. The durable journal and targeted browser paths pass. Tool-only message ownership and completed tool-card state survive checkpoint reconstruction and browser reload.

## Run

From `sweatpants/` (no sibling checkout is needed):

```sh
pnpm install --frozen-lockfile
pnpm --filter 'yo-tisyn^...' -r build
pnpm --dir apps/yo-tisyn dev:server
# In another terminal:
pnpm --dir apps/yo-tisyn dev
```

Open http://127.0.0.1:8101. The API listens on loopback port 8102.

The server uses the existing Sweatpants credential store, normally `.sweatpants/auth.json`. `YO_CHAT_MODEL_AUTH_FILE` selects another compatible file; pi's agent auth file has a different shape. The default model is `github-copilot/claude-sonnet-5.5`. Override it with `DEFAULT_CHAT_MODEL_PROVIDER` and `DEFAULT_CHAT_MODEL_ID`. The app sets `thinking: "low"`: Sonnet 5.5 rejected the provider's disabled-thinking default during this spike.

SQLite state lives in `apps/yo-tisyn/.data/chat.sqlite`. Stream buffers are in memory. Server restart recovery through HTTP is **not certified** by this spike.

## Local Cloudflare

```sh
pnpm --dir apps/yo-tisyn dev:cloudflare
# Build the Astro Worker and client assets without deploying:
pnpm --dir apps/yo-tisyn build:cloudflare
```

The local launcher uses port 8103 and defaults to OpenCode `claude-haiku-5-5`. It builds dependencies, refreshes the selected real model credential, initializes local D1, and starts Astro with the official Cloudflare adapter. It follows yo-chat's Agent Host composition: `createChatApp`, request-owned `createChatFetchHandler`, a conversation DO, D1 authority, response-stream DOs, and `cloudflare({ executors })` with `createToolExecutorObject({ tools: programs, setup })`. There is no Dynamic Worker loader or Node executor fallback.

**The loop example works locally in Cloudflare.** Executor `setup` installs the evaluation driver inside each program's owned scope. QuickJS/WASM runs a generated bundle of the resolved Tisyn kernel; this can be a published package or an explicitly linked checkout. Sweatpants still owns all tool calls, journal records, parking, and replay. Playwright verifies six accumulated replies, reload while waiting, decline, and completed-state reload with the real provider. Test Rig also replaces workerd while the loop is parked and resumes the same pending interaction.

Start a **New conversation** after this update. Work accepted under the earlier missing-driver profile is not migrated or silently restarted.

Local state and the generated signing secret live in `.wrangler/`; credentials are passed as secret bindings, not written into the bundle. The base Wrangler configuration keeps the local D1 placeholder. The production environment uses a separate provisioned database. Existing local databases are not replaced. Restart the launcher to reload refreshed credentials.

## Developing against a local Tisyn checkout

Install the Tisyn checkout with its own pinned pnpm version first (`pnpm install
--frozen-lockfile` from that repository). From `sweatpants/`:

```sh
pnpm --dir apps/yo-tisyn tisyn:local /absolute/path/to/tisyn
pnpm --dir apps/yo-tisyn tisyn:status
# After editing the kernel or its language dependencies:
pnpm --dir apps/yo-tisyn tisyn:refresh
```

The local command builds Tisyn's kernel/DSL dependency graph and replaces only
this app's four existing pnpm symlinks (`ir`, `validate`, `dsl`, `kernel`). It
records their original targets in ignored `.wrangler/tisyn-local.json`; manifests
and lockfiles remain unchanged. The repositories keep their own pnpm versions.
Run `tisyn:published` to restore the original package links and regenerate the
bundle. A reinstall may replace local links; checks fail explicitly when the
selected checkout and resolved packages disagree.

`tisyn:refresh` regenerates the QuickJS bundle after compiling the local packages.
`kernel:build` and `kernel:check` also compile a selected local checkout before
bundling, so a deployment cannot silently use stale `dist/` code. Restart the dev
server after switching between published/local packages; use a new conversation
when the evaluator identity changes.

Cloudflare builds resolve these local links at build time. Deploy with the same
`deploy:prepare` / `deploy` commands below; the remote Worker does not need the
checkout. The generated bundle and `/health` include package versions, the local
Tisyn revision, dirty state for build inputs, a source fingerprint, and the kernel
SHA-256, with no local paths. The existing Cloudflare tool profile includes the
kernel SHA-256 in its durable identity. These fingerprints describe the kernel
build; they are not a substitute for recording both repository revisions for a
reviewable deployment.

Local bundles are development artifacts. A clean checkout with published
packages will intentionally fail `kernel:check` against a locally generated
bundle. Before landing the consumer change, either pin a released candidate or
explicitly provision the recorded Tisyn checkout in CI; do not label a local
bundle as a published one. The tail-call regression tests require the candidate
kernel and are expected to fail against the current published kernel.

## Cloudflare deployment

Live: https://yo-tisyn.rauh-ryan.workers.dev

This deployment is **public and unauthenticated**, as requested. Anyone with the URL can spend the configured OpenCode quota. Conversation IDs are not access controls. Do not put sensitive data into this demo. Compute limits are not a security audit.

Production uses **OpenCode / Haiku 5.5** (`opencode/claude-haiku-5-5`). Deployment preparation copies only the stored OpenCode API key. It never includes Copilot credentials or substitutes another model. Model usage can cost money even when hosting fits free-tier quotas. No paid Cloudflare plan upgrade was made.

From `sweatpants/`, after dependency builds:

```sh
pnpm --dir apps/yo-tisyn deploy:prepare
pnpm --dir apps/yo-tisyn run deploy
```

`deploy:prepare` writes mode-0600 secret files under ignored `.wrangler/`, preserves the production signing secret, and initializes only the production D1 binding. `deploy` builds the Astro Cloudflare output with the production environment and deploys its generated Wrangler config with the secret file. Keep the signing secret stable across deployments.

The Worker environment is named `ssr`, matching yo-chat and the SDK browser-resolution settings. The default named Worker environment failed model calls after deployment even though local workerd passed. Matching `ssr` fixed deployed calls; minification and the OpenCode-only catalog also pass with that configuration.

All registered tools are durable and use the ToolExecutors DO. Agent Host and model sampling run in the Conversations DO. There are no ordinary tools requiring a ToolSessions DO. The ingress Worker routes requests.

Deployed Playwright checks cover six accumulated replies, one authored recursive program, mid-loop reload, Decline and Cancel, and completed-state reload. Remote D1 confirms exactly two model preparations per conversation: authoring and final summary. Haiku chose newline-separated accumulation for one program and direct concatenation for the other; the prompt does not specify a separator. Evidence: `../.pi/evidence/yo-tisyn-spike/deployment/`.

## Shape

Source is grouped by responsibility:

```text
src/
  workflow/              Tisyn admission, durable tool binding, and tool inventory
    tools/               The ask, echo, and sample durable programs
    evaluation/          Evaluation port, Node/QuickJS drivers, and kernel bundle
  server/                Node and Cloudflare entry points and application setup
    cloudflare/          Cloudflare placement, model catalog, and executor setup
  chat/                  Chat island, interactions, tool cards, and program preview
  threads/               Thread list and browser-local conversation index
  explain/quickjs/       QuickJS walkthrough component, script, and styles
  design-system/         Shared visual primitives and theme
  styles/                Global site styles
  layouts/               Astro site shell
  pages/                 Astro routes
  __tests__/             Application acceptance tests and Cloudflare fixtures
```

Unit tests live in `__tests__/` beside the code they exercise. The workflow layer
owns execution semantics; server composition selects its evaluation driver. Chat
presentation shares the source parser to draw plans but never runs the evaluator.

- `src/workflow/agent.ts`: one declared tool list, plus a model exposure policy.
- `src/workflow/tisyn.ts`: real DSL parser → real IR validator → restricted profile → real kernel evaluator.
- `src/workflow/evaluation/port.ts`: portable evaluation port, scope-owned sessions, and shared tool-call budget.
- `src/workflow/evaluation/node.ts`: published kernel plus the Node VM compute guard.
- `src/workflow/evaluation/quickjs.ts`: interruptible, memory-limited compute for the DO executor.
- `src/workflow/evaluation/kernel.ts`: trusted VM bridge over the published kernel. `pnpm kernel:build` generates its bundle; tests, types, and Cloudflare builds verify it with `kernel:check`.
- `src/server/cloudflare/`: Agent Host composition, conversation routing, and executor-side setup.
- `src/server/application.ts`: shared application setup for the local server and protocol test rig.
- Each external descriptor becomes a pinned Sweatpants `invoke` child with validated tool arguments.
- `echo` records its work. `ask` uses its original typed `reply` elicitation and interaction binding.
- `sample` requests a text completion through the SDK's durable sampling pull. Its prompt and optional system prompt are supplied by the authored program.
- `src/chat/ask-plugin.tsx`: the existing `makePlugin(ask).onElicit(...)` path renders the reply form.
- Generated instructions and schemas come from the same tools used for dispatch.
- Only `tisyn` is advertised to the model. The full inventory remains installed for child interaction contracts.
- A recorded pull ID supplies a replay-stable namespace for tool-start/tool-complete emissions. The model cannot supply these IDs.
- Sweatpants retains the submitted source as program input. Replay re-evaluates that source and consumes accepted outcomes. It does not ask the model for a replacement program.
- The interpreter is not wrapped in `record`. Durable boundaries remain separate.

The app imports only published package entry points: `@tisyn/dsl@0.4.8`, `@tisyn/ir@0.16.0`, `@tisyn/kernel@0.16.0`, and `@tisyn/validate@0.16.0`. Exact versions live in `package.json`; the workspace lockfile pins their tarball integrity and transitive dependencies. There are no sibling-source imports or Tisyn resolution aliases.

The interpreter digest includes the declared Tisyn versions and adapter profile. Node retains `profile-5-guarded-loops`. Cloudflare uses `profile-6-quickjs`, with the QuickJS package versions, kernel-bundle hash, and compute limits in its identity. Start a new conversation rather than resuming work accepted under a different profile. Production recovery still needs retained adapter artifacts and the matching lockfile.

## Profile

Admitted: JSON values, `Let`, `Ref`, `Seq`, `If`, `Fn`, `Call`, `While`, `Get`, `Construct`, `Arr`, `Concat`, arithmetic, comparisons, boolean operations, `Throw`, and registered `Eval` calls.

For accumulation, use recursive `Fn`/`Call` with the accumulator as a parameter. Bindings are immutable; `While` does not mutate outer bindings. One accepted program runs every round. Each call to a bound tool remains a separate durable child under the same workflow. The outer model is not called between rounds; the program can explicitly request additional completions through `sample`.

### Local syntax macros

The authoring adapter provides `When(condition, body)` and `Unless(condition,
body)`. Both lower to `If` and return `null` when their body is skipped. Authors
can also define reusable syntax templates within a single submitted program:

```text
WithMacros({"Guard": {
  "params": ["condition", "action"],
  "body": If(Hole("condition"), Hole("action"), null)
}}, Seq(
  Use("Guard", false, Eval("echo", {"message":"skipped"})),
  Use("Guard", true, Eval("echo", {"message":"runs"}))
))
```

`Hole` substitutes unevaluated syntax. Repeating a hole repeats its expression
and any effects; use a caller `Let` when an input should be evaluated once.
Definitions are local to `WithMacros` and cannot shadow another macro in scope.
This first version excludes `Let`, `Fn`, `Ref`, `Try`, and nested `WithMacros`
from templates to prevent introduced bindings from capturing caller variables.
Arguments may contain bindings and references. Use ordinary functions for
runtime recursion and state; these templates are not general Lisp macros.

Expansion is pure and bounded: 16 definitions, 8 parameters, 64 calls, 4000
visited values, and 64 levels of expansion traversal. Expanded IR still passes
the ordinary validation and tool capability checks, including skipped branches.
The authoring digest records `macroSyntax: 1`; replay expands the same stored
source under that adapter identity. Program previews show expanded IR, while
the source view retains macro definitions. No new kernel operation or durable
effect is introduced. Macros are currently an app adapter experiment.

### Decisions and branching

Both app placements enable `.decisions({ provider: "opencode", id: "jev-1.13" })`.
This capability is independent of `.samples()` and is included in workflow identity.
The model supplies classification instructions and choices in its authored program:

```text
Let("answer", Classify({
  "input": "I was charged twice",
  "instructions": "Choose the matching support category",
  "choices": {"billing": "Charges and payments", "technical": "Product problems"}
}),
  If(Eq(Get(Ref("answer"), "type"), "refusal"),
    "Classification refused",
    Switch(Get(Ref("answer"), "choice"), {
      "billing": Eval("echo", {"message": "Billing selected"}),
      "technical": Eval("echo", {"message": "Technical selected"})
    }, "Unknown category")
  )
)
```

`Classify` returns a choice answer with `choice`, `probabilities`, and `confidence`,
or `{type: "refusal"}`. Confidence is the provider's statistic, not necessarily the
selected choice's probability. `Switch(selector, cases, fallback)` evaluates its
selector once and executes only the selected branch. Admission validates every
branch. These forms lower to existing `Get`/`Eval` and `Let`/`If` IR; the published
Tisyn kernel and QuickJS bridge are unchanged. Program previews show lowered IR.

`Eval("decision", {input, question: {type: "choice", instructions, choices}})`
is the underlying capability; `choices` here is an array of `{value, description}`.
It returns `{answer, model, usage}`. The SDK exposes the same request through
`.decisions(binding)` and `yield* context.decision(request)` in durable tools.
Applications register `createDecisionEffectRegistration()` and install a scoped
provider using `installDecisionProvider(createPiAiDecisionProvider())`.

The `@sweatpants/model-decision` package owns the contract, fail-closed provider
port, and `model.decision` durable effect. Accepted answers replay from the journal,
including across park/resume; a crash before acceptance can repeat inference and
billing. Requests allow 2–64 unique labels and at most 32 KiB of encoded JSON input.
Provider responses must contain a valid distribution over exactly those labels.
Keep arithmetic, counters, and stopping rules in authored deterministic code.

This slice implements choice decisions through OpenCode Jev. The contract handles
refusal, although Jev's current Pi adapter does not produce one. OpenAI's dedicated
decisions adapter, predicate/score questions, batching, and automatic confidence
policies are not implemented.

Live validation used Haiku-authored `Classify`/`Switch`, Jev classification, a
billing-only human reply, browser reload while parked, and successful completion
with `billing:DEMO-42`. Unit coverage additionally destroys the execution scope,
restores serialized journal authority, and proves the accepted decision is not
requested again. Evidence is under `.artifacts/yo-tisyn-decisions/`.

### Sampling inside a workflow

`Eval("sample", {"prompt": ...})` returns `{"text": ...}`. Inputs are a required
nonempty `prompt` (up to 32,768 characters), an optional `systemPrompt` (up to
8,192 characters), and an optional `maxTokens` (1–4096, default 1024). The sampling
child declares `.samples()` and calls `context.sample()`. No tools or previous
conversation history are included in that request. The program must construct
any needed context explicitly, including earlier replies and sample results.

Two placements share this contract and the same model-visible instructions:

```ts
createTisynTool([echo, ask, sample]).build(); // sample is a durable child
createTisynTool([echo, ask]).samples().build(); // sample is a pull in Tisyn itself
```

Set `PUBLIC_TISYN_SAMPLING=child` (default) or `PUBLIC_TISYN_SAMPLING=direct`
before starting `dev:cloudflare`, `dev:server`, or building the Worker. Astro
captures this setting at build/start time; restart to change it. `/health` on
Cloudflare reports the selected mode. Each mode has its own workflow identity;
use a new thread when switching modes. Both emit sampling start/completion cards,
but direct mode does not create a separate sampling child. Direct sampling is
rejected unless the builder explicitly enables it, and enabling both bindings
with the same name is rejected.

The app supplies capability contracts and general Tisyn authoring guidance. It
does not supply task-specific sampling prompts, output schemas, counters, or
stopping rules. Those decisions belong to the model-authored program. Sampling
returns text; there is no new JSON parsing operation or structured-output API in
this binding. Existing platform compute and tool-call limits still apply.

Accepted sampling outcomes belong to the durable journal, so reconstruction
consumes them instead of requesting replacement completions. Enabling sampling
changes the workflow identity through the tool inventory or native capability;
use a new conversation for this version. The earlier loop evidence below covers
ask/echo workflows. The sampling comparison is recorded separately below.

Choose **Loop until I decline** on the empty conversation screen: **ask me for input in a loop until I decline, echo the accumulated response as it goes**. Selecting an example fills and focuses the task input; it does not send it.

Rejected: `Try`, concurrency, resource/scope operations, computed structural IR, and undeclared effects. Admission checks the IR, including unselected branches and generic `Eval` IDs. This deliberately rejects some otherwise valid Tisyn data.

The profile limits source length, source nesting, array length, and visited IR values. It rejects selected prototype-related fields. Evaluation allows at most 256 tool calls per program. Node gives each synchronous kernel advance a 250 ms wall-clock timeout. Cloudflare gives each advance 256 QuickJS interrupt checks, with a 32 MiB VM allocation limit and 128 KiB VM stack limit. Human wait time consumes neither budget. The Cloudflare budget is not a wall-clock deadline or an exact Tisyn instruction count. Limits fail explicitly, never as successful completion.

The Node evaluation driver runs the fixed expression `kernel.next(input)` through Node's VM timeout. It does not compile authored source to JavaScript or add a Tisyn runtime. The VM is **not a security or memory sandbox**. This is a wall-clock guard, not a deterministic instruction budget; heavy machine load can cause rejection. Intermediate value growth still occurs in the server process, and the final result-size check runs after evaluation. Tool string limits still apply. Use trusted local inputs only.

## Evaluation placement

`TisynEvaluationPort` declares `open`, `advance`, and `close` as Effection operations. It carries IR, temporary session IDs, JSON replies, and yielded descriptors or final values. It does not carry JavaScript callbacks or own durable work. Missing installation fails explicitly; there is no unguarded fallback.

The Node server installs `createNodeEvaluationDriver()` in the `inProcess({ setup })` generator. The application accepts an execution adapter rather than importing a Node evaluator. A remote executor must install its driver in its own execution scope; HTTP ingress setup does not cross a process boundary.

`createEvaluation()` owns the session as an Effection resource. Scope exit closes it on return, failure, cancellation, or durable parking. Its tool-call cap applies before it exposes another descriptor. The driver must enforce the compute bound, since Effection cancellation cannot interrupt non-yielding synchronous work.

Cloudflare installs the QuickJS driver through the executor's `setup` generator. Its engine counter interrupts pure loops even when the Workers clock does not advance during synchronous work. The stack limit keeps recursive failure inside the VM, before the host WASM stack overflows. Each temporary VM is disposed when its evaluation closes. The JSON bridge rejects non-finite numbers instead of silently converting them to null. These compute limits are not a security audit or a whole-DO memory quota. A negative configuration test still verifies fail-closed behavior when executor setup is omitted. No kernel source or Tisyn runtime changes are required.

## Presentation

The Astro shell and React islands use a local StyleX design system. Its semantic component roles follow the `@yodash/base` surface model. The first theme is Rosé Pine dark. Filled actions own semantic surfaces, quiet actions use container tints, and disabled controls use neutral overlays. The site does not depend on the Dynobase repository at build time.

The site root opens the playground. QuickJS is the visual explainer. `/playground` always redirects to a fresh `/threads/[id]` URL; reloading or opening that URL resumes the same conversation. The browser index retains up to twelve recent IDs and tolerates malformed stored JSON.

The QuickJS Astro component restores the original standalone SVG walkthrough, with 25 steps across three scenarios, moving packets, component inspection, zoom, scrubbing, keyboard stepping, and reduced-motion support. Its native diagram styles use the same Rosé Pine palette as the StyleX shell.

Empty conversations show three editable starting points: a running response loop, combining two replies, and a simple echo. The task input starts empty. Example buttons replace the draft and focus the input without submitting. Examples disappear once the conversation has messages. The composer has its own top spacing.

Tool cards show readable status and results. Echo displays its text once. Ask displays one reply or decline/cancel outcome, including after reload. Input and result JSON remain in collapsed details. Unknown result shapes use a labeled JSON fallback.

The Tisyn card parses its source with the published DSL and IR packages. It shows a Mermaid plan for sequences, bindings, branches, functions, and loops. Each named function body appears once. Dashed call edges link only unambiguous names; shadowed and computed calls remain labels. `While` includes a back edge and stop branch. Expressions stay in node labels. The plan is not an execution trace and does not claim which branch ran. Nested tool cards show actual execution results.

The diagram supports enlargement and a text outline. Formatted source stays available in a collapsed panel. Source parsing shares the execution path's length/nesting checks; diagrams have a separate 64-node cap. Generated labels escape Mermaid syntax and HTML. Parse/render errors produce a visible explanation and preserve the source, without blocking tool interaction. The browser never runs the Tisyn evaluator.

## Evidence

`pnpm --dir apps/yo-tisyn test`: **88 passing tests**: five sampling capability/contract tests plus 24 profile/durable binding tests, 6 loop protocol scenarios, one twenty-reply Cloudflare checkpoint-spill scenario, 7 Cloudflare placement/guard scenarios, 21 evaluator/guard tests, 10 program-plan tests, 11 presentation/example tests, one OpenCode model-catalog test, and two browser-index recovery tests. Cloudflare covers real DO execution, parked-loop recovery after workerd replacement, decline/cancel, compute and memory limits, non-JSON rejection, and a healthy evaluation after each failure.

The durable binding tests use the real parser, validator, kernel, durable tools, journal authority, and program driver. They verify:

- Sequential invocation and recorded echo results.
- Park with zero live evaluator attachments.
- Destroy the first Effection root scope, serialize the authority snapshot, and rebuild a new authority and driver.
- Accept, decline, and cancel replies after reconstruction.
- No re-entry into the completed first echo child.
- Rejection of an invalid typed reply before a valid reply is accepted.
- Preservation of the accepted journal prefix.
- Malformed source, unsupported operations, and invalid tool arguments fail without entering an echo child.
- Model exposure contains only `tisyn`, while `ask` keeps its interaction contract.

These are scope/snapshot recovery tests, **not an OS-process-kill or SQLite recovery test**. Echo has no external service client. Entry observation wraps the real echo program; it does not replace its result.

### Sampling comparison (2026-10-12)

Computer-use checks ran against real local Cloudflare/workerd with OpenCode
Haiku 5.5. Both modes used identical model-visible capability descriptions and
no task-specific app prompt. One plain game request per mode produced individual
`ask` programs, with no sampling or durable game loop. Child mode continued in
ordinary chat after question one; direct mode issued a second single-question
program. This is a small behavioral observation, not a model reliability estimate.

A separate neutral user request explicitly asked for a repeated word-association
workflow using sampling. Both modes authored one recursive program, sampled
`Sea` for `ocean`, survived browser reload while parked, sampled `Woods` for
`forest`, and accepted Decline. The journal distinguishes the two sample-child
invocations in child mode from the native sample pulls in direct mode. This
covers browser reload, not process replacement during a pending sample.

The programs returned only `Stopped.` (child) or `done` (direct); both outer
model summaries then incorrectly said no words had been exchanged. The accepted
tool cards and journals show both rounds. The follow-up below tests generic guidance
about returning enough workflow state for the final summary.

Snapshots, screenshots, generated source, and journal counts are under
`.artifacts/yo-tisyn-sampling/` at the workspace root.

#### Generic authoring guidance follow-up

The tool description now asks for a complete interactive workflow, sampling with
explicit accumulated context when reasoning is needed, and a final value that
preserves completed work and the reason for stopping. The single-question example
was removed. No game-specific prompt, counter, or output schema was added.

Real Haiku 5.5 browser checks with the same plain game request produced these
observations (two child attempts, one direct attempt):

- All three authored recursive sampling loops with a twenty-question bound.
  The first child attempt failed syntax validation before executing.
- The child retry sampled two questions and stopped its workflow on Decline.
  It nevertheless returned only `Game stopped by user.`. The outer model then
  attempted another game workflow, which failed syntax validation. Its first
  program included a `correct` branch, but that branch was not exercised.
- Direct mode sampled two questions and resumed after a parked browser reload.
  Decline did not stop its generated loop: it sampled a third question and parked
  again. Its source omitted action handling and early success handling. This
  thread remains parked for inspection; the twenty-question bound was not run
  to completion.
- The neutral word-association request failed syntax validation in direct mode.
  Child mode reported `chat_segment_order_invalid` and showed no reply control;
  reload showed an empty conversation still waiting for a reply. Its journal
  retains pending work. Neither neutral run reached a final summary.

This small sample shows improved whole-interaction planning, not reliable program
correctness or improved summaries. It also exposes a separate stream/hydration
failure whose cause has not been established. Useful next experiments are
syntax-validation feedback and model repair before execution, generic terminal
result handling, and recovering the missing parked interaction. Preserve these
failed attempts when comparing future changes.

Evidence is under `.artifacts/yo-tisyn-sampling/guidance-v2/`, including generated
source, browser snapshots/screenshots, and journal entries. App tests and app
type checks pass. The broader landing gate remains blocked by the previously
observed Redis skip-baseline regression (19 skips against 17); this follow-up
does not rerun that unchanged failure.

#### Complete games with generic validation feedback

`tisyn` accepts `validateOnly: true` to parse and check admitted operations without
creating an evaluator or running effects. It returns `valid` or `invalid`, an
`executed: false` marker, and parser diagnostics on failure. Execution retains
the existing fail-closed behavior. Generic guidance asks the model to validate,
repair up to three times, then execute the same source. The outer iteration
budget is six: initial validation, three repairs, execution, and final summary.
A generic accumulation-loop example and explicit terminal-result guidance help
authoring; no game prompt, counter, or success protocol is supplied by the app.

Two complete real Haiku 5.5 games used the unchanged user request
“I'm thinking of a word, let's play 20 questions”:

| Mode                    | Hidden word | Observed result                                                                                                                                                                                                                                            |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct `.samples()`     | elephant    | One syntax repair, then nine questions in one executing workflow. Reloaded at question eight, confirmed the ninth-question guess, returned a useful success result, and summarized correctly.                                                              |
| Registered sample child | umbrella    | Three syntax repairs, then exactly twenty questions in one executing workflow. Reloaded at question twelve, returned `out_of_questions` with all twenty Q&A pairs, and summarized accurately without starting another workflow. It did not guess the word. |

The journal confirms nine native sampling pulls in the direct game and twenty
sample-child invocations in the child game, plus their separate outer authoring,
validation-feedback, and summary requests. Both ended with an enabled composer.
The game's rules and sampling prompts were authored by the model. This proves
the capability in these runs, not reliable strategy or syntax generation.

Longer play exposed three shared projection bugs: replaying answered-elicitation
deltas after their activity records were archived; dropping ancestor placement
anchors while re-checkpointing retained descendants; and treating stale archived
anchor data as conflicting with a loaded parent's completed result. The runtime
now replays only retained activity deltas, carries ancestor anchors forward,
and gives loaded parent bodies precedence over stale anchor data while checking
placement identity. Earlier failed attempts remain as evidence; recovery of
every previously failed publication is not established by these successful runs.

The twenty-reply regression also exposed stack exhaustion at 64 KiB. The final
128 KiB QuickJS limit passes both the finite loop and existing infinite-recursion
failure/recovery checks. A 256 KiB trial passed the finite loop but failed VM
cleanup under infinite recursion, so it is not the retained setting. Live games
ran before that final reduction; the twenty-round Cloudflare regression and all
existing guards pass at 128 KiB. A compute-only replay of both exact generated
programs at 128 KiB matched every accepted tool descriptor and final result:
18 calls for the direct game and 40 for the child game. This replay used recorded
results and made no replacement model requests.

Browser snapshots, screenshots, generated programs, and selected journal facts
are in `.artifacts/yo-tisyn-sampling/full-game/`. The expanded deterministic test
covers twenty replies, parked reload, completion, and final model history.

### Integrated loop

The app's Test Rig scenarios run six accepted replies inside one `tisyn` call, reopen midway, then decline or cancel. In-process, HTTP, and Cloudflare DO execution pass. The Cloudflare cases destroy and recreate workerd while parked before reopening. The real application client and provider SDK stay in the request path. There is one model request before the loop and one after it stops. Follow-up history contains only the outer call/result; the UI retains all child calls. Separate authority tests destroy the Effection scope and restore a JSON snapshot after six replies without repeating echo work.

The real Copilot browser check also passes with the default prompt: six accumulated echoes, reload before the fourth reply, then decline. There is one workflow card and one Mermaid diagram. The journal contains exactly two model preparations: initial authoring and final summary. Completed cards survive a further reload. Evidence: `../.pi/evidence/yo-tisyn-spike/loop-integration/browser.json` and `completed.png`.

Guard tests cover effectful infinite loops, non-yielding `While` (including an empty body), pure recursion, VM memory exhaustion, and non-JSON values. The Node VM guard also runs behind a separate process watchdog. Actual workerd scenarios verify the Cloudflare guard and subsequent healthy execution.

The Cloudflare browser evidence lives in `../.pi/evidence/yo-tisyn-spike/cloudflare-loop/`. It starts from the **Loop until I decline** button, uses the real Copilot provider, reloads during the loop, and checks the D1 journal for exactly two model preparations.

### Snapshot ownership and browser status

The shared chat projector retains a tagged tool opener's owner on its parent assistant message, including messages with no text opener. The stream validator remains strict. Core and checkpoint regression tests cover the snapshot round trip and reject a mismatched owner.

Activity checkpoints fold tool results together with placement events in journal order. Placement snapshots and deltas cannot undo a settled tool result. Tests cover both successful and failed results. Provider history stays separate, so activity-only UI does not enter model context.

`packages/platform-acceptance/src/__tests__/nested-tool-ownership.acceptance.test.ts` exercises a plain authored parent and child, without Tisyn. It uses the real provider client against the Test Rig HTTP simulator. All four cases pass: in-process and HTTP, with and without client reopen. They check interaction identity, owner preservation, completed results, and no repeated recorded work. They also assert the parent and child cards' final state and output, both after completion and after reopening the completed conversation. A follow-up message checks that the outer model receives only the parent call and result, not the child's execution history.

The targeted real Copilot Sonnet 5.5 browser smoke check **passes**. The reply form survived reload. Accepting the reply completed the program, produced a final model response, and returned the chat to `ready`. All four cards (`tisyn`, `echo`, `ask`, `echo`) showed `output-available` with their results. Reloading the completed conversation preserved those states. This is browser reload coverage, not process-replacement coverage.

The presentation browser check also passes: a real Mermaid SVG, reply submission across reload, one displayed reply, expandable source, completed-conversation reload, and no document overflow at 390px width. Enlargement and fit controls also pass on the saved conversation. Evidence: `../.pi/evidence/yo-tisyn-spike/presentation/browser.json`, `enlarge.json`, `completed.png`, and `mobile.png`.

A separate real-provider check completed two replies and an echo, then sent two follow-up messages in the same conversation, with a reload between them. Both follow-ups passed. The fix filters child-owned messages and their paired tool results when building conversation-model context from stored public roots. It retains child cards in the UI. The original failure was a provider HTTP 400 caused by an internal child-call ID leaking into model history. Evidence: `../.pi/evidence/yo-tisyn-spike/follow-up/browser.json` and `provider-repro.log`.

Child `invoke` calls still need authored lifecycle emissions for chat correlation. Keep child interaction contracts in the inventory and filter only model exposure. A higher-level composition helper remains a separate design decision.

Evidence outside this repo: `../.pi/evidence/yo-tisyn-spike/` contains the browser reproduction, JSON transcript, screenshots, provider probe, server failure log, and build/landing logs.

## Fresh-checkout dependency check

Before the presentation update, an isolated source copy passed with no sibling repositories, existing `node_modules`, or populated pnpm store:

- `pnpm install --frozen-lockfile` using an empty store.
- `pnpm --filter 'yo-tisyn^...' -r build`.
- App tests (20), type check, and production build.
- Server startup with a temporary SQLite database and `GET /health`.

All four Tisyn imports resolved to registry packages inside that copy. An app import audit found no undeclared packages or relative imports outside the repository. Normal `workspace:*` links point to packages inside Sweatpants, not another checkout. Logs: `../.pi/evidence/yo-tisyn-spike/npm-dependencies/`.

## Gates

- Complete-game validation: app 88 passed, chat core 128 passed, durable chat runtime 147 passed (363 total). Focused type checks and formatting passed.
- The October 12 complete-game landing run passed stages 1–10, including clean builds, repository lint, package/test/app types, and formatting. Stage 11 completed its package tests but failed the coverage gate: Redis was unavailable at `localhost:6379`, causing 19 skips against the baseline of 17. The baseline was not changed; stages 12–21 did not run. Summary: `.artifacts/landing/2026-10-12T11-03-04-342Z-deterministic/summary.json`.
- Evaluation-port iteration: app tests, types, production build, and focused type-aware lint pass. Evidence: `../.pi/evidence/yo-tisyn-spike/evaluation-port/`.
- Cloudflare loop iteration: app tests/types and all 16 Cloudflare runtime tests pass. Existing executor conformance fixtures now require setup-installed services during replay and cancellation. Evidence: `../.pi/evidence/yo-tisyn-spike/cloudflare-loop/`. The earlier placement-only checkpoint remains documented under `cloudflare-local/`; it did not make the example work. No full landing rerun, as requested.
- Platform acceptance: 99 tests passed. The SQLite lane passed all 42 tests on a separate run after an initial timeout; no timeout was increased.
- Package and test type checks, focused type-aware lint, and repository formatting passed. The app's focused lint has no warnings or errors.
- The loop-integration and empty-state landing run used a temporary real Redis server. Stages 1–17 passed, including the package coverage gate that Redis skips had blocked. The skip baseline was not changed. The temporary server was removed after the run.
- Stage 18 (`test:yo-chat`) failed: `book-flight-ephemeral-invariance.acceptance.test.ts` / `survives graceful runtime-generation replacement between turns` rejects an `input-available` tool activity that still carries a result. The targeted test reproduces the failure. Record projection treats a failed child task as a global error and emits an interrupted result for its still-pending replacement. A later input-end event leaves that result on an unfinished activity. This is unresolved; validation and acceptance expectations remain unchanged. Stages 19–21 did not run.
- Landing summary: `.artifacts/landing/2026-10-10T12-19-17-509Z-deterministic/summary.json` under `sweatpants/`.
- Latest landing log: `../.pi/evidence/yo-tisyn-spike/loop-integration/landing.log`. The unchanged host-replacement failure is described in `../.pi/evidence/yo-tisyn-spike/presentation/LANDING-FINDINGS.md`. Full landing remains incomplete.
- `pnpm land:live` was not run; no provider integration changed. The targeted real-provider browser check above passed.

## Decision from this spike

Keep the one-runtime approach. The kernel-to-durable-child binding works at the journal boundary. Before promoting it, test actual host replacement with persistent storage, add memory isolation, and retain immutable implementation artifacts. The local compute/time and tool-call guards are not production resource isolation. Concurrency and catchable error translation remain out of scope.
