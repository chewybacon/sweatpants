# yo-tisyn: durable workflow engines

**Status: sequential durable workflows, including guarded loops. Not a finished app or a security sandbox.**

Scheme and the Tisyn comparison engine drive existing Sweatpants durable tools. The journal owns accepted work; evaluator instances are disposable. Tool-only message ownership and completed tool-card state survive checkpoint reconstruction and browser reload.

## Scheme engine

New conversations in the product use the Hoot Scheme engine. The Tisyn engine remains
installed for the existing comparison/acceptance lanes; it is not exposed alongside
Scheme to the authoring model.

- One Scheme expression executes in WASM, with proper tail calls, lexical functions,
  named loops and local hygienic `syntax-rules` macros.
- `ask`, `sample`, `decision`, `random` and document capabilities bind to the existing
  Sweatpants contracts. Sampling inherits the caller's reasoning configuration.
- `(invoke 'expression input)` creates a journaled child with a fresh evaluator.
  The parent waits for its result. Intermediate effects survive host replacement.
- `(with-reply request accepted stopped)` composes Ask with typed accept/decline/cancel
  handling. Accepted callbacks receive both content and the original exchange.
- `validateOnly` expands/compiles without effects. Reader/expansion diagnostics return
  to the authoring model. Runtime authored faults include a completed-effect count;
  retrying a workflow does not undo accepted effects.

The journal remains authoritative. Evaluators and their continuations are disposable:
recovery replays recorded results into a fresh instance. There is no new parking or
scheduler primitive. Tool activity and existing Ask plugins render nested effects;
Scheme source is shown directly, without a static canvas projection yet.

`@sweatpants/scheme-runtime` owns the port, bridge and limits; `tool.ts` binds
capabilities; `node.ts` and `worker.ts` load the same generated WASM. The Worker adapter
uses static WASM modules, so it needs no runtime code generation. `packages/scheme-runtime/scripts`
contains the compiler input and fuel instrumentation. Generated assets and source
hashes are checked by `pnpm scheme:check`. Rebuild with Docker using:

```sh
pnpm --dir apps/yo-tisyn scheme:build
```

Fuel bounds WASM control flow, including expansion, and JSON boundaries have size/depth
limits. This is **not a memory or wall-clock sandbox**: native allocation has no separate
quota. Dependency notices are in `packages/scheme-runtime/licenses`. Engine tests cover tail
calls, macros, validation, fuel exhaustion and fresh-instance recovery. Cloudflare
acceptance tests replace workerd while a child is waiting for a human reply.

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

The server uses the existing Sweatpants credential store, normally `.sweatpants/auth.json`. `YO_CHAT_MODEL_AUTH_FILE` selects another compatible file; pi's agent auth file has a different shape. The default model is `github-copilot/claude-sonnet-5.5`. Override it with `DEFAULT_CHAT_MODEL_PROVIDER` and `DEFAULT_CHAT_MODEL_ID`. Reasoning defaults to `medium`; override it with `DEFAULT_CHAT_MODEL_THINKING`.

SQLite state lives in `apps/yo-tisyn/.data/chat.sqlite`. Stream buffers are in memory. Server restart recovery through HTTP is **not certified** by this spike.

## Local Cloudflare

```sh
pnpm --dir apps/yo-tisyn dev:cloudflare
# Copilot (the same local Cloudflare runtime):
pnpm --dir apps/yo-tisyn dev:cloudflare --provider github-copilot --model gpt-6.1-sol
pnpm --dir apps/yo-tisyn dev:cloudflare --provider github-copilot --model claude-opus-5.5
# Discover models available with your refreshed credential:
pnpm --dir apps/yo-tisyn dev:cloudflare --provider github-copilot --list-models
# Override reasoning and port:
pnpm --dir apps/yo-tisyn dev:cloudflare --thinking high --port 8104
# Build the Astro Worker and client assets without deploying:
pnpm --dir apps/yo-tisyn build:cloudflare
```

The local launcher uses port 8103 and defaults to OpenCode `claude-haiku-5-5` with `medium` reasoning. `--provider github-copilot` defaults to `gpt-6.1-sol`. Flags override `DEFAULT_CHAT_MODEL_PROVIDER`, `DEFAULT_CHAT_MODEL_ID`, and `DEFAULT_CHAT_MODEL_THINKING`; other arguments pass through to Astro. Use `--help` for options. The launcher checks model availability before starting; it never falls back to another model. Restart to switch models, then use a new conversation for a clean comparison. The footer and `/health` show the active configuration. It builds dependencies, refreshes the selected real model credential, initializes local D1, and starts Astro with the official Cloudflare adapter. It follows yo-chat's Agent Host composition: `createChatApp`, request-owned `createChatFetchHandler`, a conversation DO, D1 authority, response-stream DOs, and `cloudflare({ executors })` with `createToolExecutorObject({ tools: programs, setup })`. There is no Dynamic Worker loader or Node executor fallback.

**The loop example works locally in Cloudflare.** Executor `setup` installs the evaluation driver inside each program's owned scope. QuickJS/WASM runs a generated bundle of the resolved Tisyn kernel; this can be a published package or an explicitly linked checkout. Sweatpants still owns all tool calls, journal records, parking, and replay. Playwright verifies six accumulated replies, reload while waiting, decline, and completed-state reload with the real provider. Test Rig also replaces workerd while the loop is parked and resumes the same pending interaction.

Start a **New conversation** after this update. Work accepted under the earlier missing-driver profile is not migrated or silently restarted.

Local state and the generated signing secret live in `.wrangler/`; credentials are passed as secret bindings, not written into the bundle. The base Wrangler configuration keeps the local D1 placeholder. The production environment uses a separate provisioned database. Existing local databases are not replaced. Restart the launcher to reload refreshed credentials.

For simultaneous model comparisons, give each server a separate local state path
and port. The path is relative to `apps/yo-tisyn` and is used by both D1
initialization and Astro. Do not point two running servers at the same directory.
Vite dependency caches are already separated by sampling mode, provider, and model.

```sh
TISYN_LOCAL_STATE_PATH=.wrangler/opus-state pnpm --dir apps/yo-tisyn dev:cloudflare --provider github-copilot --model claude-opus-5.5 --port 8107
```

### Verify reasoning against real providers

```sh
pnpm --dir apps/yo-tisyn verify:reasoning
pnpm --dir apps/yo-tisyn verify:reasoning --provider github-copilot --model gpt-6.1-sol
pnpm --dir apps/yo-tisyn verify:reasoning --provider github-copilot --model claude-opus-5.5
```

Each command makes three small real requests through the app's canonical Pi adapter, at low, medium, and high. It checks outgoing provider effort fields and successful responses. Output contains only reasoning configuration, token usage, and the synthetic reply—not headers or credentials. Haiku and Opus use adaptive thinking plus `output_config.effort`; Sol uses `reasoning.effort`. These checks verify configuration and API acceptance, not how much internal reasoning a provider actually performs. Refresh credentials with `pnpm model:auth:refresh --provider github-copilot` first if needed.

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

`Sample({prompt: ...})` (or `Eval("sample", {...})`) binds directly to the
SDK sampling capability. Both the Tisyn evaluator and the session coordinator
declare `.samples()`; there is no registered `sample` wrapper tool.

```ts
createTisynTool([echo, ask]).samples().build();
```

Requests contain only explicitly authored context and history. Text and structured
sampling inherit the caller's resolved thinking level; an optional `thinking`
field overrides it. Structured requests add `schema` and return a validated
`parsed` value or a repairable validation failure. The SDK implements structured
sampling and tool sampling on the same lower-level sampling pull.

Sampling still emits UI start/completion cards and records outcomes in the
journal. `/health` reports `sampling: "native"`. The earlier child/direct
comparison below is historical; `PUBLIC_TISYN_SAMPLING` no longer selects a mode.
Use a new thread after upgrading, because capability and session identities changed.

The app supplies capability contracts and general authoring guidance. Task-specific
schemas, counters, stopping rules, and context selection belong to authored programs.

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

The Tisyn card renders one read-only React Flow canvas focused on yields and continuations. A static continuation-passing projection reads authoring IR before lowering. Ask, Sample, and Classify become yield nodes; pure bindings and counter updates disappear; edge labels describe branch outcomes; branches preserve control flow, with normal returns sharing one End node and failures sharing a separate Fail node. Return expressions remain in the endpoint source tooltip. Statically resolved calls connect to shared bodies with recursion back edges. Function resolution follows the kernel's caller environment, including parameter shadowing and function-valued arguments. Specializations include the return continuation, so distinct callers do not receive one another's returns.

Unresolved targets, effectful call arguments, unsupported control constructs, and recursive calls with a changing continuation remain explicit operation nodes with source details. The projection never executes code or claims runtime state. Canvas colors follow the app’s Rose Pine palette: teal for native Sample/Decision capabilities (including Classify sugar), iris for authored host tools such as Ask and document tools, and gold for control flow. Icons and provenance labels accompany the colors. Unknown operations retain a neutral dashed treatment rather than claiming a tool origin. It is bounded with a visible truncation notice. There is no sidebar, inspector, expansion control, minimap, or attribution badge. The graph runs left to right with compact endpoints. Single-entry cyclic regions are grouped in a subtle Repeat container; terminals remain outside. This first pass groups maximal cycles, so nested cycles share a region. Multi-entry cycles retain explicit edges. Ordinary steps align horizontally, while consecutive branch checks form vertical columns. Branch columns are sized as blocks before laying out the surrounding graph. Orthogonal routes use side gutters and dedicated dashed return lanes above the loop. Drag to pan; pinch or use zoom and fit controls. Ordinary wheel scrolling moves the surrounding page. Original and expanded source remain below, along with actual activity results.

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

## Workflow documents and choices

The document spike exposes `document_create`, `document_read`, `document_edit`,
and `present_choices` to authored Tisyn programs through ordinary `Eval` calls.
No new Tisyn kernel instruction or input-wait mechanism is involved.

Documents belong to the root workflow. Its child tools share access; another
root workflow cannot read or edit them, even if it knows a reference. Documents
and operation receipts are persisted in journal authority control, using the
existing memory, SQLite, or D1 execution-store placement. Each document command
atomically stores its revision and receipt. The subsequent effect settlement
uses the existing journal path; a retry between these commits returns the
original receipt before checking the revision again.

Edits require `expectedRevision`. Patches use `set` and `remove` with explicit
path segments: `{ op: "set", path: ["items", "0"], value: "new value" }`.
`set` at `[]` replaces the document. Array `set` replaces an existing element or
appends at its length; `remove` shifts later elements. Invalid paths fail the
whole edit. A conflict returns the current snapshot without changing it.

A read with `sinceRevision` returns the current snapshot and ordered changes
ending at that same revision. The authority retains the last 32 edits; an older
revision receives a `reset`. Limits are 16 KiB per document, 64 patches per edit,
32 documents and 512 operation receipts per authority session, and 1 MiB of
aggregate document state. Completed workflows are reclaimed on a subsequent
document operation; their historical tool results remain in the transcript.
These are bounded spike limits, not an indexed document database.

Durable tool authors declare read-only document slots beside elicitation context:

```ts
.elicits({
  choose: {
    response: z.object({ id: z.string() }),
    context: z.object({ message: z.string() }),
    documents: { content: ContentSchema },
  },
})
```

The workflow binds `{ documents: { content: { id, sinceRevision } } }` when calling
`ctx.elicit`. The SDK records a document read, validates the slot content, and
side-loads the observation in the elicitation wire envelope. The plugin sees
its original `input.context` and a typed `ctx.documents.content.read()` operation.
The handle contains a detached, deeply frozen snapshot, with no mutation method
or server credential. Content schemas also participate in binding identity.

`present_choices` renders JSON content, revision changes, and list/grid buttons.
Buttons use the existing accept/decline/cancel elicitation response. Accepted IDs
are checked against the presented choices on the server. The workflow decides
what the response means and whether to edit the document.

This first slice refreshes documents on each elicitation. It does not subscribe
an already-open UI to concurrent changes. Documents contain generic JSON; slot
schemas validate typed views, but this slice does not provide model-authored
schema registration, shared conversation/workspace documents, stored macros,
or indexed views. No document mutation endpoint is exposed to the browser.

### Program-selected views and collection operations

The yo-chat authored games separate program state (board, turn, ordered moves),
UI context (board/history/last move and terminal status), and inner-model context
(the state and legal actions supplied to that particular sample). The Tisyn
surface now supports that pattern without a game-specific tool or system prompt:

- `JsonGet(value, key)` supports computed object keys and existing array indices.
- `JsonSet(value, key, replacement)` returns an updated copy.
- `JsonAppend(array, item)`, `JsonLength(arrayOrString)`, and `JsonKeys(object)`
  support program-owned collections and history; `JsonStringify(value)` provides
  an explicit textual representation.
- These constructors lower to a bounded pure adapter operation. They do not run
  JavaScript, read documents, invoke children, or emit intermediate tool cards.
  Node and QuickJS share the implementation. Outputs are limited to 32 KiB and
  programs to 4096 JSON operations, separately from the 256 tool-call limit.
- `sample` accepts optional JSON `context`, serialized alongside its prompt.
  Native sampling uses this explicit input. The combined
  prompt/context is limited to 32 KiB. No document or transcript is automatically
  attached. A program can choose to include permitted state, ordered interaction
  history, role information, and available actions.
- `present_choices` supports `columns` and per-choice `disabled` flags. Disabled
  choices preserve grid positions, and the server rejects their selection.
- `display_document` renders a read-only document with optional grid/list cells
  and automatically acknowledges delivery. It does not ask for another human
  move or leave the workflow parked at the terminal display. Completed document
  presentations reconstruct their saved revision from the elicitation snapshot
  after reconnect, without running plugins or effects again.

These are explicit-context mechanisms, not an enforced secrecy boundary against
model-authored programs: a program that can read a private value could still
copy it into a sample or its final result. Hidden-information applications need
trusted handles and controlled disclosure. Public-information applications can
explicitly share their board and history with each inner model call. Document
contents remain separate from the immutable elicitation context and from the
outer model's conversation history unless the program returns them.

### Flat bindings and sequential collection helpers

`LetMany([["name", expression], ...], body)` lowers to nested `Let` bindings.
Bindings evaluate once in order, later bindings can refer to earlier ones, and
repeated names shadow earlier values. The final body is the result. Up to 64
bindings are admitted, with the normal expanded-program budget still applied.

```text
LetMany([
  ["items", [2, 4, 6]],
  ["total", Reduce(Ref("items"), 0,
    Fn(["sum", "item", "index"], Add(Ref("sum"), Ref("item"))))]
], Construct({"total": Ref("total")}))
```

- `Map(array, Fn(["item", "index"], body))` collects callback results.
- `Filter(array, Fn(["item", "index"], predicate))` keeps matching input items.
- `Reduce(array, initial, Fn(["acc", "item", "index"], body))` folds left.

Callbacks receive exactly the listed arguments, with zero-based indices. Input
expressions evaluate once, in argument order. Arrays are checked before the loop;
empty arrays invoke no callbacks. Helpers lower to ordinary tail-recursive
`Fn`/`Call` loops and bounded JSON operations, so callbacks can use the existing
effects, park points, and replay behavior. There is no parallel dispatch or new
kernel operation. Generated names avoid all strings in the authored source,
including callback parameters and nested helpers. `LetMany` is forbidden inside
binding-free macro templates; it can still be passed through a macro hole.

### Quoted child hello world experiment

The journal-backed tests in `src/workflow/__tests__/tisyn.test.ts` register a
**test-only** `delegate` tool. This proves child composition without exposing a
new tool or `Invoke` constructor in the chat app:

```text
Let("reply", Eval("delegate", {
  "code": Q(Fn(["name"],
    Eval("echo", {"message": Concat("Hello, ", Ref("name"), "!")}))),
  "args": ["world"]
}), Concat("Parent received: ", Get(Ref("reply"), "message")))
```

Result: `Parent received: Hello, world!`

`Q` preserves the function IR inside effect data. The existing validator rejects
quotes directly in structural evaluation positions such as a `Let` value, so
this experiment does not establish general first-class quoted-code bindings.
The child receives explicit JSON arguments and opens a fresh evaluator without
the parent's environment. Its interpreter advances `.next(previousResult)` and
forwards `echo` and `ask` effects through pinned durable child invocations. The
parent resumes with the recorded child result. In the QuickJS variant, each
evaluator has its own context/runtime within the loaded WASM module.

The second experiment records a greeting, parks inside the child on `ask`,
destroys the scopes, and restores the authority from serialized JSON. It checks
that the greeting is not repeated and that the parent receives the child's final
result. Both experiments run against Node and QuickJS with the real journal and
tool programs; no model or provider is involved.

```sh
pnpm --dir apps/yo-tisyn exec vitest run src/workflow/__tests__/tisyn.test.ts
```

The experimental child dispatcher supports `echo`, `ask`, and the optional
`greet` handler below. Code admission, capability selection, and nested handler
scopes remain design work before a public primitive.

### One program, two effect interpretations

The same test harness also runs this identical source with two implementations
of `greet`:

```text
Let("result", Eval("delegate", {
  "code": Q(Fn(["name"], Eval("greet", {"name": Ref("name")}))),
  "args": ["world"]
}), Construct({"parentReceived": Ref("result")}))
```

Both implementations accept `{name}` and return either `{status:"ok", text}` or
`{status:"decline"|"cancel"}`:

- The pure handler computes `Hello, world!` without external work.
- The human handler invokes the real durable `ask` tool with
  `How should we greet world?`. An accepted reply becomes the greeting; declining
  or cancelling returns that status through the child to the parent.

The human execution path is parent → quoted child → greeting handler → ask.
There is still no `Park` instruction: the driver parks while resolving the
elicitation. Tests destroy the scopes, restore the journal from JSON, supply a
reply through the authority, and verify one elicitation and three child
invocations with no duplicate requests after recovery. Both Node and QuickJS
exercise accept, decline, and cancel. These are deterministic harness replies,
not a live browser experiment.

Handler selection in these two experiments is host-configured. Each implementation
has a distinct manifest digest, and the delegated interpreter's digest includes
its handler bindings. This proves interchangeable durable implementations of one
effect contract. The following experiment moves handler implementation into
Tisyn itself.

### Tisyn-authored effect handlers

The test-only `delegate` interpreter accepts an optional `handlers` object.
Each key names an admitted effect, and each value is a quoted unary function
that receives the effect's JSON input and returns its result:

```text
Let("result", Eval("delegate", {
  "code": Q(Fn(["name"], Eval("greet", {"name": Ref("name")}))),
  "args": ["world"],
  "handlers": {
    "greet": Q(Fn(["request"], Construct({
      "status": "ok",
      "text": Concat("Authored hello, ", Get(Ref("request"), "name"), "!")
    })))
  }
}), Construct({"parentReceived": Ref("result")}))
```

Result: `{parentReceived: {status: "ok", text: "Authored hello, world!"}}`.

The handler is invoked through the same pinned durable `delegate` program with
its code and request as journaled input. It opens its own evaluator. The child
waits for its recorded return value, then resumes through `.next(value)`.
Changing only the quoted handler to a function that calls `ask` makes the same
child program interactive. Tests cover acceptance, decline, and cancellation
after destroying all evaluator scopes and restoring journal JSON.

This experiment defines a deliberately limited scope:

- The handler table applies to effects yielded by that delegated program.
- A handler executes with the host bindings and an empty local handler table.
  Calling its own effect name therefore reaches the host implementation.
- Calls outside the delegated program retain their host bindings.
- Handlers receive one explicit input and cannot read parent lexical bindings.
- Inputs and returned values must satisfy the admitted tool's existing contract.
- Explicit JSON arguments are passed through literal wrappers, so IR-shaped
  values are not accidentally executed.

Invalid handler arity, invalid output, and references to parent-only variables
fail the invocation; later parent effects do not run. Code and handler tables are
recorded invocation inputs, while the interpreter identity pins its host bindings.
There is no general `Handle` constructor, nested handler stack, resumption value
exposed to the handler, or public chat capability yet. These tests exercise
ordinary durable delegation with caller-authored implementations, not multi-shot
continuations or resumable error handling.

### Two turns with one resumable child

The `session` tool in `src/workflow/session.ts` drives two Tisyn evaluators
within one durable program. It is installed in the local and Cloudflare tool
inventories and callable from authored Tisyn. It is not an independently
addressable child task or an external messaging API.

Parent requests are `session.send`, `session.answer`, `session.close`, and
`session.cancel`.
Child requests are `session.receive`, `session.askParent`, and
`session.turnResult`. These names are ordinary effects interpreted by the
coordinator; no kernel operations were added.

The important child expression is:

```text
Let("nextMessage", Eval("session.turnResult", {"findings":"..."}),
  ...)
```

The effect's data becomes a turn-result event delivered to the parent. When the
parent sends another turn, that message becomes `nextMessage`. The child's
program has not returned, so its earlier bindings remain logically available.
An `askParent` request similarly receives its answer through `.next(answer)`.
Returning from the child instead produces a distinct `closed` event.

The experiment runs this sequence in both Node and QuickJS:

1. Parent sends `Investigate A` as turn 1.
2. Child asks `What budget should I use?`.
3. Parent delegates that question to the real durable `ask` tool.
4. All evaluator scopes are destroyed; authority is restored from journal JSON.
5. The harness supplies `$500`; the parent answers the correlated child question.
6. Child records its findings through `echo` and yields the first turn result.
7. Parent sends `Compare B` as turn 2. The second result includes both messages
   and the budget from the first turn.
8. Parent closes; child returns its final summary.

Session ID, sequential turn ID, and question request ID enforce one active turn
and one outstanding question. A new turn or close while a question is pending,
an answer with mismatched IDs, and a parent returning with an open child fail
explicitly. Each exchange is recorded, ordinary effects use pinned durable
invocations, and replay reconstructs both evaluators and checks their exchanges
against journal truth. There is no saved generator stack or mailbox.

This proves the turn/question/final-result distinction under one coordinator.
Multiple sessions, independent child ownership, and external message delivery
remain outside this implementation. The parent can explicitly cancel an open
child, including one awaiting an answer; this returns a `cancelled` event and
discards its evaluator. Cancellation does not execute child cleanup code. Tests
cover decline/cancel after restoring the parent human elicitation.

### Authoring a session in the app

Call `Eval("session", {sessionId, parent, child})` inside the outer Tisyn program.
`parent` and `child` are DSL source strings. The tool validates both completely
before starting either evaluator, including unselected branches. Parent-only and
child-only session effects are admitted separately. Ordinary tools use the same
pinned registrations and UI events as other Tisyn calls. `sample` is available
inside sessions in either outer sampling mode; all sampling context is explicit.

Use `validateOnly: true` on the session request for a side-effect-free nested
source check. The outer Tisyn validator sees the source strings as data, so an
outer validation success alone does not validate their contents.

Each session allows 64 exchanges and 256 ordinary tool calls, and bounds values
to 32 KiB. Each evaluator also retains the existing compute and JSON-operation
limits. Session IDs identify the one conversation within this invocation; they
cannot reconnect independent workflows to each other. No task-specific prompts
or bookstore logic are included in the tool implementation.

### Exchanges and conversational repair

`ask` and `present_choices` return `{action: "accept", content, exchange}` on
acceptance. Decline and cancel have no exchange. The JSON projection is
`{messages: [...]}`: the existing SDK assistant tool-call and tool-result pair,
with a runtime-owned, replay-stable call ID. Documents and UI context are not
copied into those messages. Keep exchanges in a local array with `JsonAppend`;
pass that array to `sample` as `exchanges`. Each exchange should occur once.

`sample` accepts `prompt`, optional `exchanges`, selected JSON `context`, and
optional `schema` (a bounded JSON Schema vocabulary advertised in its tool
contract). Native sampling uses this adapter. The adapter
validates history, flattens the messages, and appends the current prompt. Nothing
implicitly attaches the chat transcript or documents.

- Text success: `{status: "ok", text, exchange}`.
- Structured success: `{status: "ok", text, parsed, exchange}`. The schema is
  converted to Zod, supplied to the SDK's `sampleSchema`, and validated locally.
- Structured response validation failure: `{status: "invalid", text: "",
parseError: {message}}`. No exchange is fabricated for this failure: the SDK
  does not return the raw failed completion. Provider and cancellation errors
  still propagate. Invalid/unsupported schema definitions fail before sampling.

For example, this constructor DSL requests a typed interpretation of an accepted
reply. This is an illustrative composition; live authoring observations are
recorded below.

```js
Let(
    "reply",
    Eval("ask", { message: "What name should I use?" }),
    If(
        Eq(Get(Ref("reply"), "action"), "accept"),
        Eval("sample", {
            prompt: "Interpret the reply. If the intended name is unclear, return clarify and a question.",
            exchanges: Construct([Get(Ref("reply"), "exchange")]),
            schema: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["answer", "clarify"] },
                    value: { type: "string" },
                },
                required: ["kind", "value"],
                additionalProperties: false,
            },
        }),
        Construct({ stopped: Get(Ref("reply"), "action") }),
    ),
);
```

An authored repair loop keeps literal exchanges separate from current accepted
facts: elicit, append the exchange, interpret against current state, validate the
proposal, then apply or clarify. Schema validation establishes structure; program
logic must validate target IDs and task constraints. A correction changes the
current fact and recomputes its dependent values, preserving earlier exchanges.
Document edits use `expectedRevision`; local state can instead travel through
recursive function parameters. Bound retry loops, retain state when sampling is
invalid, and avoid automatically repeating external effects. These are composing
instructions, not a task-specific interpreter or an automatic rollback facility.

### Exchange authoring helpers

`Ask` accepts a conversational presentation as well as the question:

```text
Ask({
  title: "Weekend plans",
  message: "What kind of afternoon would you like?",
  detail: "We can adjust the plan as we go.",
  placeholder: "Tell me what sounds good…",
  suggestions: ["Something relaxed", "An outdoor adventure", "A bit of both"]
})
```

Only `message` is required. Suggestions fill an editable draft; they never submit
automatically or restrict the human's response. The plugin provides a multiline
reply, a 4096-character limit, keyboard submission (Ctrl/Command+Enter), and
separate decline/cancel actions under Other options. Blank replies are rejected
by both the UI and response contract. Accepted text is preserved verbatim.
Optional presentation fields are recorded in the elicitation context and included
in its exchange. They are visible to the user: keep undisclosed state out of them.
Completed cards use the same presentation after reconnect.

The source adapter exposes `Ask(request)` and `Sample(request)` as ordinary
registered effect calls. `OnAccepted(result, Fn([content, exchange], body),
Fn([stop], body))` evaluates the result once and lazily selects acceptance or
stopping. `OnParsed(result, Fn([value, exchange], body), Fn([error], body))` does
the same for structured sample success or validation failure. Callback parameter
names in actual DSL source are quoted strings. OnParsed requires a structured
sample; text-only samples use their ordinary result envelope. Callbacks can also
be `Ref("handler")` bound to a named function, so existing handlers compose
without wrapper lambdas. Literal callback arities are checked before execution;
named callbacks use ordinary function-call validation. Generated bindings avoid
authored names.

`ObjectSchema({field: StringSchema()})` produces a strict object schema with all
fields required. `EnumSchema("answer", "clarify")`, `ArraySchema(itemSchema)`,
`NumberSchema()`, `IntegerSchema()`, and `BooleanSchema()` are also available.
These are static constructors, lowered before capability validation. Raw supported
JSON Schema remains available for optional properties, bounds, and unions.

All helpers lower to existing IR operations. They add no kernel keywords,
scheduler, implicit state mutation, or implicit history. The model must still
choose an interpretation step and author its state transitions. The generic
authoring guidance describes the values produced by each capability: Ask obtains
a reply, Classify selects a label, Sample generates text or typed data, and pure
expressions compute exact results. The author chooses the composition. Literal
exchanges and current accepted state remain separate.

The chat UI sends a short task-independent `systemPrompt` through the host's
existing request control (`src/chat/authoring.ts`). It frames capability selection
around the value needed by the next step and the information each result can carry.
Direct API clients supply their own policy. Tool reference text retains callable parameter/result schemas, but omits
internal elicitation/UI schemas that Tisyn cannot directly invoke.

Structured sampling inherits thinking. With reasoning enabled, the Pi adapter
uses its reasoning-aware stream and offers the synthetic schema tool with automatic
selection, plus a schema-return instruction. It validates the returned value;
selection is not guaranteed and an invalid result remains a repairable failure.
With thinking off, the existing forced schema-tool path remains available.

Exact constraints should be checked by deterministic authored functions before
acting on a sampled proposal. A failed check can feed a bounded repair attempt.
These are authoring recommendations, not automatic proof or repair by the host.

### Live authoring observations (2026-10-13)

With opencode Haiku at medium authoring effort, the generic UI policy and exchange
helpers produced a shopping-list workflow from an ordinary human request. In one
complete browser run it added two items, corrected a quantity, removed an item,
added another, and clarified an ambiguous quantity change without changing state.
Reloading while clarification was pending preserved the question; answering it
resumed the workflow and `done` returned the corrected list (one carton of milk,
six bananas). These are observations from an exploratory run, not a success rate.

A profile-collection run still stored a correction literally in the current field,
despite using Ask/OnAccepted. The outer model noticed the error after completion,
but the workflow itself did not repair it. Helper availability and guidance do
not guarantee that an author chooses structured interpretation. The next useful
composition is a small reusable human-turn interpreter with explicit current
state, relevant exchanges, a response schema, and accepted/clarify/stop outcomes.
That higher-level helper is not implemented here.

The live loop also found two adapter problems: computed Sample requests were
unnecessarily rejected by the source helper, and structured sampling inherited
thinking incompatible with Pi's forced schema tool. Both are fixed with focused
regressions. No task-specific system prompt was added.

A separate 20 Questions run authored a recursive loop with an explicit 20-turn
bound and forwarded elicitation exchanges to each structured sample. It asked
19 questions and guessed on turn 20. The guess (washing machine) was wrong; the
fixed secret was cello. Its guess contradicted an earlier no-electricity answer.
This distinguishes a working interaction loop from good inference. Its exhausted
branch also discarded local history, identifying a second useful composition:
a bounded conversation loop whose terminal outcomes retain accumulated state.

After that terminal result, the outer author started an unsolicited second game.
Declining it ended the interaction at the outer tool-iteration limit. A terminal
conversation result should preserve state and clearly distinguish finished work
from an invitation to reauthor or restart; this remains an authoring limitation.

### Bulls and Cows with repeated digits (2026-10-13)

A live browser run kept `4331` private and asked Haiku to play with repeated digits
allowed. The initial program accepted feedback but proposed guesses contradicting
earlier scores. We cancelled it after three replies.

After adding generic guidance to validate proposals deterministically, a fresh
program authored duplicate-aware scoring and checked candidates against every
accepted score. It accepted `1234` and `1345`, then rejected three invalid sampled
proposals and returned the accumulated history. An ordinary “Yes, keep going from
the history” continuation authored text sampling with thinking followed by
structured extraction and the same deterministic checks. It guessed `1403`,
`6314`, then `4331`; we confirmed four bulls and it finished without restarting.
All five guesses in this run were independently checked against the prior scores.
No secret or game-specific system prompt was supplied to the model.

This is one exploratory success across two programs, not a consistency estimate.
Syntax repairs were still needed. The program also eagerly bound its next proposal
before checking the winning score, causing unnecessary sampling after completion.
Generic guidance now calls out terminal checks before effectful `LetMany` bindings;
that final guidance has not yet been validated in another live game. A reusable
proposal/validation/repair composition should carry rejected values and check
failures forward rather than resampling the same request unchanged.

The run also exercised long-thread hydration. The UI now exposes the client's
existing history paging and suppresses empty-state examples while a conversation
is blocked or has older activity. Loading earlier activity recovered the transcript.
Transient missing/stale cards and ordering during hydration remain an observation
to investigate; the paging control alone does not establish a runtime fix.
Local sources, score audit, and screenshot: `.artifacts/bulls-4331/`.

### Outer iterations and program diagrams

The chat renders existing tool and activity states as an ownership tree. Active
descendants appear with their tool path; nested message containers group output
without inventing another agent identity. Completed or failed tools stop activity
traversal, and opaque activities are not expanded. A pending elicitation is labeled
as waiting for input (or submitting/failed locally). A parked authority without a
visible pending interaction is labeled as waiting for the workflow to resume.
Neither parked state nor nesting proves that a human response or another agent is
involved. The compact current-activity view uses the latest assistant message;
the full transcript retains the other roots. This UI adds no lifecycle events or
reasoning stream to the sampling service.

Both local and Cloudflare compositions set `maxToolIterations: null`. This disables
the outer authoring-round cap; each delegated Tisyn invocation can already contain
many samples, elicitation replies, parks, and resumes without incrementing that
outer counter. Other applications retain the default limit. Explicit cancellation
and the kernel's per-activation computation bounds remain available. The limit is
part of a turn's recorded input, so this configuration applies to newly admitted
turns rather than rewriting journal history.

Program previews wait for complete tool input before parsing. The native program
map preserves high-level constructs and keeps named function bodies in separate
views. Large programs produce a marked, bounded outline with full source retained.
Invalid source shows a diagnostic without blocking tool interaction. The map uses
ordinary React and CSS, so rendering no longer depends on Mermaid or SVG layout.

## Recorded randomness

`Random({"min": 0, "max": 2})` (or `Eval("random", {"min": 0, "max": 2})`)
is a native Tisyn host effect returning a uniform integer directly. Both bounds
are inclusive signed 32-bit integers and `min` must not exceed `max`. The effect
uses Web Crypto with rejection sampling to avoid modulo bias and works in Node
and Cloudflare. It is available without enabling model sampling.

```text
Random({"choices": ["red", "green", "blue"]})
```

The `choices` form returns the selected string label directly, with equal
probability for each label. Supply 1–64 distinct, nonempty strings of at most
200 characters each. Supply either `choices` or `min`/`max`, never both. The
selected label itself is recorded; the request identity includes choice order.

Each executed draw passes through Sweatpants `context.record`; the accepted
value is journaled before execution continues. Recovery returns that recorded
value without drawing again. Separate calls (including loop iterations) create
separate records. A draw lost before journal acceptance can be retried; an
accepted value never changes. This is deterministic replay, not a user-seeded
PRNG or a guarantee that separate program invocations produce identical values.
Validation-only calls do not draw. The canvas identifies Random as a built-in,
and the activity stream uses the same start/completion events as other effects.
