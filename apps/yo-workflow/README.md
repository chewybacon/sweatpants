# yo-workflow

Author, run, and inspect durable workflows. This app was renamed from yo-tisyn;
its deployed Cloudflare worker, D1 databases, signing-secret file, and existing
workers.dev hostname deliberately retain their resource identities.

## Playground languages

Choose **Scheme** or **Lua** in the task composer, then send the same natural-language
message. The real model authors and validates a program in the selected language;
the program drives the shared interaction cards and journaled tools. The selection
is locked while a task is active. See [language parity](docs/language-parity.md) for
supported capabilities, explicit limits, conformance evidence and the update process.

## Execution inspector

The **Execution** navigation opens `/execution`. A Scheme or Lua caller invokes the same compiled TypeScript
developer confirmation generator through the selected runtime, the shared program
driver, and the real journal authority. A real model authors the caller; the demo
outbox records receipts without sending email.

```sh
# From the workspace root, build package dependencies first if needed.
pnpm --filter 'yo-workflow^...' build
pnpm --filter '@sweatpants/flowmode-backend...' build
# Uses the Scheme runtime pinned Docker toolchain image (build it via scheme:build if absent).
pnpm --filter yo-workflow execution:build
pnpm --filter yo-workflow execution:test
pnpm --filter yo-workflow execution:dev
```

Open `/execution` on the local URL reported by Astro. Run confirmation, inspect
stack/locals/cleanup, restore in a fresh instance, then approve, decline, or cancel.
Release the pending cleanup to finish. **Restore** inspects the journal's accepted
checkpoint without advancing it; answering uses the normal shared-driver recovery
path. Park already disposes compute. The source panel shows the actual generator
and emitted Scheme; the timeline distinguishes kernel transitions from accepted
journal outcomes. Raw frames remain available below the environments.

Runs survive browser reload and local workerd replacement through the `?run=` URL.
The Cloudflare journal uses local D1 and run metadata uses Durable Object storage.
Each run retains at most 100 trace events. State inspection is private to this local
playground and is never fed into model history. This is boundary inspection, not
single-expression stepping or historical state time travel.

The local Cloudflare ExecutionLab Durable Object uses the same service and evaluator
protocol as the Node test harness. Cloudflare bundles static WASM modules,
stores the authoritative execution journal in D1, and persists source, inspection
metadata, and idempotent announcement receipts in Durable Object storage. Each
request reconstructs the service from storage; each park releases the evaluator.
Authoring uses the configured real provider, validates in an isolated evaluator
without dispatching effects, and retries invalid source with diagnostics.
The outbox records demo receipts only; it does not send email.

Run `execution:compile` and `execution:build` after changing the developer
workflow or checkpoint kernel, before `build:deploy` produces the Cloudflare bundle. The `EXECUTION_LABS` binding
uses one Durable Object per run; the `v2-execution-lab` migration adds its class.

## Durable workflow engine

**Status: sequential durable workflows, including guarded loops. Not a finished app or a security sandbox.**

Scheme workflows drive existing Sweatpants durable tools. The journal owns accepted work; evaluator instances are disposable. Tool-only message ownership and completed tool-card state survive checkpoint reconstruction and browser reload.

## Scheme engine

Scheme conversations use the Hoot Scheme engine; Lua uses Piccolo/Wasm through the same durable tool hosting protocol.

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
Scheme source and a program map are available alongside the execution timeline.

`@sweatpants/flowmode-runtime-scheme` owns the port, bridge and limits; `tool.ts` binds
capabilities; `node.ts` and `worker.ts` load the same generated WASM. The Worker adapter
uses static WASM modules, so it needs no runtime code generation. `packages/flowmode-runtime-scheme/scripts`
contains the compiler input and fuel instrumentation. Generated assets and source
hashes are checked by `pnpm scheme:check`. Rebuild with Docker using:

```sh
pnpm --dir apps/yo-workflow scheme:build
```

Fuel bounds WASM control flow, including expansion, and JSON boundaries have size/depth
limits. This is **not a memory or wall-clock sandbox**: native allocation has no separate
quota. Dependency notices are in `packages/flowmode-runtime-scheme/licenses`. Engine tests cover tail
calls, macros, validation, fuel exhaustion and fresh-instance recovery. Cloudflare
acceptance tests replace workerd while a child is waiting for a human reply.

## Run

From `sweatpants/` (no sibling checkout is needed):

```sh
pnpm install --frozen-lockfile
pnpm --filter 'yo-workflow^...' -r build
pnpm --dir apps/yo-workflow dev
```

Open the local URL reported by the launcher (port 8103 by default). Playground,
Threads, and the walkthrough share the same origin as the Cloudflare chat API.
The launcher prepares D1 and real model credentials before starting Astro.
Use `execution:dev` to compile the developer workflow before launching all pages,
including the local execution inspector.

`dev:server` remains a standalone Node API on port 8102 for Node runtime work; it
is not needed by the Cloudflare-backed UI. Running `astro dev` directly skips
credential and database preparation and is not the full-app launch command.

## Local Cloudflare

```sh
pnpm --dir apps/yo-workflow dev:cloudflare
# Copilot (the same local Cloudflare runtime):
pnpm --dir apps/yo-workflow dev:cloudflare --provider github-copilot --model gpt-6.1-sol
pnpm --dir apps/yo-workflow dev:cloudflare --provider github-copilot --model claude-opus-5.5
# Discover models available with your refreshed credential:
pnpm --dir apps/yo-workflow dev:cloudflare --provider github-copilot --list-models
# Override reasoning and port:
pnpm --dir apps/yo-workflow dev:cloudflare --thinking high --port 8104
# Build the Astro Worker and client assets without deploying:
pnpm --dir apps/yo-workflow build:cloudflare
```

The local launcher uses port 8103 and defaults to OpenCode `claude-haiku-5-5` with `medium` reasoning. `--provider github-copilot` defaults to `gpt-6.1-sol`. Flags override `DEFAULT_CHAT_MODEL_PROVIDER`, `DEFAULT_CHAT_MODEL_ID`, and `DEFAULT_CHAT_MODEL_THINKING`; other arguments pass through to Astro. Use `--help` for options. The launcher checks model availability before starting; it never falls back to another model. Restart to switch models, then use a new conversation for a clean comparison. The footer and `/health` show the active configuration. It builds dependencies, refreshes the selected real model credential, initializes local D1, and starts Astro with the official Cloudflare adapter. It follows yo-chat's Agent Host composition: `createChatApp`, request-owned `createChatFetchHandler`, a conversation DO, D1 authority, response-stream DOs, and `cloudflare({ executors })` with `createToolExecutorObject({ tools: programs, setup })`. There is no Dynamic Worker loader or Node executor fallback.

## Cloudflare deployment

Live: https://yo-tisyn.rauh-ryan.workers.dev

This deployment is **public and unauthenticated**, as requested. Anyone with the URL can spend the configured OpenCode quota. Conversation IDs are not access controls. Do not put sensitive data into this demo. Compute limits are not a security audit.

Production uses **OpenCode / Haiku 5.5** (`opencode/claude-haiku-5-5`). Deployment preparation copies only the stored OpenCode API key. It never includes Copilot credentials or substitutes another model. Model usage can cost money even when hosting fits free-tier quotas. No paid Cloudflare plan upgrade was made.

From `sweatpants/`, after dependency builds:

```sh
pnpm --dir apps/yo-workflow deploy:prepare
pnpm --dir apps/yo-workflow run deploy
```

`deploy:prepare` writes mode-0600 secret files under ignored `.wrangler/`, preserves the production signing secret, and initializes only the production D1 binding. `deploy` builds the Astro Cloudflare output with the production environment and deploys its generated Wrangler config with the secret file. Keep the signing secret stable across deployments.

The Worker environment is named `ssr`, matching yo-chat and the SDK browser-resolution settings. The default named Worker environment failed model calls after deployment even though local workerd passed. Matching `ssr` fixed deployed calls; minification and the OpenCode-only catalog also pass with that configuration.

All registered tools are durable and use the ToolExecutors DO. Agent Host and model sampling run in the Conversations DO. There are no ordinary tools requiring a ToolSessions DO. The ingress Worker routes requests.

## Implementation

- `src/workflow/scheme/`: Scheme authoring, diagnostics, and replay binding.
- `src/workflow/tools/`: questions, documents, choices, and echo.
- `src/workflow/bound-tool.ts`: shared durable tool contract.
- `src/server/`: Agent Host composition, models, and deployment setup.
- `src/chat/`: program maps, timeline, and interaction cards.
- `execution/`: snapshot-capable kernel inspector and Cloudflare service.

The retired DSL evaluator, QuickJS bundle, local-checkout linker, and comparison
harness are removed. `build`, `check`, and `test` verify only the Scheme assets.
Deployment resource names and the `tisyn.random/v2` journal key remain stable so
this source cleanup does not rename Cloudflare resources or change replay keys.

## Checks

```sh
pnpm --dir apps/yo-workflow check
pnpm --dir apps/yo-workflow test --maxWorkers=1 --no-file-parallelism
pnpm --dir apps/yo-workflow build:cloudflare
```

Scheme acceptance exercises the real Cloudflare runtime through Test Rig. Product
apps use real model providers. Run tests sequentially to bound worker processes.

### Same compiled tool in both runtimes

`execution:compile` emits both Scheme and Lua artifacts from
`apps/yo-workflow/execution/review-draft.workflow.ts`. Its ordinary
SDK DurableTool export remains separate. The model authors only the caller;
`send_announcement` stays a host effect. Approve/decline/cancel all pass through
the compiled tool's yielding `ensure` cleanup. Release cleanup before a successful
caller can enqueue its announcement. Neither runtime imports a compiler at run time.

Both runtimes capture and verify restoration of accepted checkpoints. Scheme
projects lexical environments and cleanup frames; Lua exposes VM frames, stack
references and checkpoint data, but its lexical-environment and cleanup projections
are explicitly unavailable. The UI must not equate these inspection capabilities.

Evidence: `execution/__tests__/service.mjs` covers both runtimes and both park points;
`tsdown-authoring/__tests__/runtime.mjs` verifies common source, host composition and
compiler-free artifact imports; `lua-compiler/__tests__/runtime.mjs` covers return,
throw, cancellation, yielding cleanup and shared captures in Lua and Hoot.

### Automatic workflow compilation

Execution imports its ordinary `reviewDraft` SDK tool. `workflowPlugin()` in the
Astro Vite configuration recognizes `"use workflow"` and attaches Scheme and Lua
artifacts automatically. `pnpm dev` and `pnpm build` need no separate tool
compilation step. Evaluator Wasm build prerequisites are unchanged.

Edits and supported local type dependencies invalidate compilation. Unsupported
source blocks the module with a Vite diagnostic. Existing persisted Execution
runs are pinned to their program digest: after changing compiled code, start a
new run. Unchanged builds still support Restore in fresh instance.

`execution:compile` remains the standalone artifact build used by the Node
conformance fixtures; it is not the application startup path.
