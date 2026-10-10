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

## Shape

- `src/agent.ts`: one declared tool list, plus a model exposure policy.
- `src/tisyn.ts`: real DSL parser → real IR validator → restricted profile → real kernel evaluator.
- `src/evaluation.ts`: portable evaluation port, scope-owned sessions, and shared tool-call budget.
- `src/evaluation-node.ts`: published kernel plus the Node VM compute guard.
- `src/application.ts`: shared application setup for the local server and protocol test rig.
- Each external descriptor becomes a pinned Sweatpants `invoke` child with validated tool arguments.
- `echo` records its work. `ask` uses its original typed `reply` elicitation and interaction binding.
- `src/ask-plugin.tsx`: the existing `makePlugin(ask).onElicit(...)` path renders the reply form.
- Generated instructions and schemas come from the same tools used for dispatch.
- Only `tisyn` is advertised to the model. The full inventory remains installed for child interaction contracts.
- A recorded pull ID supplies a replay-stable namespace for tool-start/tool-complete emissions. The model cannot supply these IDs.
- Sweatpants retains the submitted source as program input. Replay re-evaluates that source and consumes accepted outcomes. It does not ask the model for a replacement program.
- The interpreter is not wrapped in `record`. Durable boundaries remain separate.

The app imports only published package entry points: `@tisyn/dsl@0.4.8`, `@tisyn/ir@0.16.0`, `@tisyn/kernel@0.16.0`, and `@tisyn/validate@0.16.0`. Exact versions live in `package.json`; the workspace lockfile pins their tarball integrity and transitive dependencies. There are no sibling-source imports or Tisyn resolution aliases.

The interpreter digest includes the declared Tisyn versions and the manually versioned adapter profile. The loop-capable profile is `profile-5-guarded-loops`. It changes that identity; start a new conversation rather than resuming work accepted under an older profile. Production recovery still needs retained adapter artifacts and the matching lockfile.

## Profile

Admitted: JSON values, `Let`, `Ref`, `Seq`, `If`, `Fn`, `Call`, `While`, `Get`, `Construct`, `Arr`, `Concat`, arithmetic, comparisons, boolean operations, `Throw`, and registered `Eval` calls.

For accumulation, use recursive `Fn`/`Call` with the accumulator as a parameter. Bindings are immutable; `While` does not mutate outer bindings. One accepted program runs every round. Each ask/echo remains a separate durable child under the same workflow. The outer model is not called between rounds.

Choose **Loop until I decline** on the empty conversation screen: **ask me for input in a loop until I decline, echo the accumulated response as it goes**. Selecting an example fills and focuses the task input; it does not send it.

Rejected: `Try`, concurrency, resource/scope operations, computed structural IR, and undeclared effects. Admission checks the IR, including unselected branches and generic `Eval` IDs. This deliberately rejects some otherwise valid Tisyn data.

The profile limits source length, source nesting, array length, and visited IR values. It rejects selected prototype-related fields. Evaluation allows at most 256 tool calls per program. Each synchronous kernel advance has a 250 ms wall-clock timeout; waiting for a human does not consume that timeout. Limits fail explicitly, never as successful completion. Recursive programs also remain subject to the JavaScript stack limit.

The Node evaluation driver runs the fixed expression `kernel.next(input)` through Node's VM timeout. It does not compile authored source to JavaScript or add a Tisyn runtime. The VM is **not a security or memory sandbox**. This is a wall-clock guard, not a deterministic instruction budget; heavy machine load can cause rejection. Intermediate value growth still occurs in the server process, and the final result-size check runs after evaluation. Tool string limits still apply. Use trusted local inputs only.

## Evaluation placement

`TisynEvaluationPort` declares `open`, `advance`, and `close` as Effection operations. It carries IR, temporary session IDs, JSON replies, and yielded descriptors or final values. It does not carry JavaScript callbacks or own durable work. Missing installation fails explicitly; there is no unguarded fallback.

The Node server installs `createNodeEvaluationDriver()` in the `inProcess({ setup })` generator. The application accepts an execution adapter rather than importing a Node evaluator. A remote executor must install its driver in its own execution scope; HTTP ingress setup does not cross a process boundary.

`createEvaluation()` owns the session as an Effection resource. Scope exit closes it on return, failure, cancellation, or durable parking. Its tool-call cap applies before it exposes another descriptor. The driver must enforce the compute bound, since Effection cancellation cannot interrupt non-yielding synchronous work.

The current extraction preserves the Node guard and interpreter profile. A future driver with different evaluation semantics or limits needs a new profile/digest. A workerd probe confirms that the portable port loads and fails closed without installation. A bounded Cloudflare driver and deployment are still pending.

## Presentation

Empty conversations show three editable starting points: a running response loop, combining two replies, and a simple echo. The task input starts empty. Example buttons replace the draft and focus the input without submitting. Examples disappear once the conversation has messages. The composer has its own top spacing.

Tool cards show readable status and results. Echo displays its text once. Ask displays one reply or decline/cancel outcome, including after reload. Input and result JSON remain in collapsed details. Unknown result shapes use a labeled JSON fallback.

The Tisyn card parses its source with the published DSL and IR packages. It shows a Mermaid plan for sequences, bindings, branches, functions, and loops. Each named function body appears once. Dashed call edges link only unambiguous names; shadowed and computed calls remain labels. `While` includes a back edge and stop branch. Expressions stay in node labels. The plan is not an execution trace and does not claim which branch ran. Nested tool cards show actual execution results.

The diagram supports enlargement and a text outline. Formatted source stays available in a collapsed panel. Source parsing shares the execution path's length/nesting checks; diagrams have a separate 64-node cap. Generated labels escape Mermaid syntax and HTML. Parse/render errors produce a visible explanation and preserve the source, without blocking tool interaction. The browser never runs the Tisyn evaluator.

## Evidence

`pnpm --dir apps/yo-tisyn test`: **62 passing tests**: 24 profile/durable binding tests, 4 app protocol scenarios, 13 evaluator/guard tests, 10 program-plan tests, and 11 presentation/example tests.

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

### Integrated loop

The app's Test Rig scenarios run six accepted replies inside one `tisyn` call, reopen midway, then decline or cancel. Both in-process and HTTP bindings pass. The real application client and provider SDK stay in the request path. There is one model request before the loop and one after it stops. Follow-up history contains only the outer call/result; the UI retains all child calls. Separate authority tests destroy the Effection scope and restore a JSON snapshot after six replies without repeating echo work.

The real Copilot browser check also passes with the default prompt: six accumulated echoes, reload before the fourth reply, then decline. There is one workflow card and one Mermaid diagram. The journal contains exactly two model preparations: initial authoring and final summary. Completed cards survive a further reload. Evidence: `../.pi/evidence/yo-tisyn-spike/loop-integration/browser.json` and `completed.png`.

Guard tests cover effectful infinite loops, non-yielding `While`, and pure recursion. Non-yielding tests run behind a separate process watchdog so a broken guard cannot hang the test runner.

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

- App tests: 62 passed. Earlier shared-package checks: chat core 127 passed; durable chat runtime 147 passed.
- Evaluation-port iteration: app tests, types, production build, and focused type-aware lint pass. No full landing rerun, as requested. Evidence: `../.pi/evidence/yo-tisyn-spike/evaluation-port/`.
- Platform acceptance: 99 tests passed. The SQLite lane passed all 42 tests on a separate run after an initial timeout; no timeout was increased.
- Package and test type checks, focused type-aware lint, and repository formatting passed. The app's focused lint has no warnings or errors.
- The loop-integration and empty-state landing run used a temporary real Redis server. Stages 1–17 passed, including the package coverage gate that Redis skips had blocked. The skip baseline was not changed. The temporary server was removed after the run.
- Stage 18 (`test:yo-chat`) failed: `book-flight-ephemeral-invariance.acceptance.test.ts` / `survives graceful runtime-generation replacement between turns` rejects an `input-available` tool activity that still carries a result. The targeted test reproduces the failure. Record projection treats a failed child task as a global error and emits an interrupted result for its still-pending replacement. A later input-end event leaves that result on an unfinished activity. This is unresolved; validation and acceptance expectations remain unchanged. Stages 19–21 did not run.
- Landing summary: `.artifacts/landing/2026-10-10T12-19-17-509Z-deterministic/summary.json` under `sweatpants/`.
- Latest landing log: `../.pi/evidence/yo-tisyn-spike/loop-integration/landing.log`. The unchanged host-replacement failure is described in `../.pi/evidence/yo-tisyn-spike/presentation/LANDING-FINDINGS.md`. Full landing remains incomplete.
- `pnpm land:live` was not run; no provider integration changed. The targeted real-provider browser check above passed.

## Decision from this spike

Keep the one-runtime approach. The kernel-to-durable-child binding works at the journal boundary. Before promoting it, test actual host replacement with persistent storage, add memory isolation, and retain immutable implementation artifacts. The local compute/time and tool-call guards are not production resource isolation. Concurrency and catchable error translation remain out of scope.
