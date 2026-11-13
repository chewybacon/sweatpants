# Playground language parity

The composer selects the language for the next task. The message stays unchanged.
`src/chat/authoring.ts` sends the selection and language-specific authoring policy;
`src/server/cloudflare.ts` selects the model-facing inventory through
`src/workflow/agent.ts`. All durable tools remain registered so earlier work can
resume. The selection is disabled during an active task and remembered per thread
in this browser. The authoritative execution language is the journaled tool call.

## Current capabilities

| Capability | Scheme Playground | Lua Playground | Source and evidence |
| --- | --- | --- | --- |
| Model authors, validates, then executes source | Supported | Supported | `src/workflow/scheme/tool.ts`, `src/workflow/lua/tool.ts`; `src/chat/__tests__/authoring.test.ts`, `src/workflow/__tests__/language.test.ts`, Lua `__tests__/validation.test.ts` |
| Questions, replies, sequential loops and branches | Supported | Supported | Both tool adapters invoke the shared `src/workflow/tools/ask.ts`; both `__tests__/durability.test.ts` suites; real-provider browser evidence below |
| Journaled random choice, pending reply recovery | Supported | Supported | `src/workflow/random.ts`; both durability suites verify accepted random result and journal prefix survive reconstruction |
| Sampling, decisions, documents | Wired to shared contracts | Wired to shared contracts | Both tool adapters; `src/workflow/sampling.ts`, `decisions.ts`, `tools/documents.ts`; shared contract tests. Lua end-to-end coverage of these capabilities remains to be added |
| Child authored workflows | Supported (`invoke`) | Not implemented | Scheme tool and durability tests; Lua reference explicitly excludes invocation |
| Source and execution timeline | Supported | Supported | `src/chat/tool-view.tsx`, `workflow-activity.tsx`, `__tests__/tool-view.test.tsx` |
| Static program map | Supported | Not implemented | `src/chat/scheme-flow.ts`; Lua shows its source and runtime timeline |
| Concurrent spawn/join/all/race | Not in Playground | Experimental, test-only | `experiments/workflow-kernel/scoped-handoffs/`; separate evaluator, not used by either Playground tool |
| Shutdown-safe timers/deadlines | Not implemented | Not implemented | Scoped-handoffs timer contracts fail closed; no timer wakeup driver |

Lua runs ordinary Lua syntax in Piccolo/Wasm with a deliberately limited library:
`assert`, `type`, `pcall`, `error`, JSON helpers and the registered capabilities.
There is no `math`, `string`, `table`, IO, import, or coroutine library. Scheme's
supported forms and procedures are generated in `@sweatpants/flowmode-runtime-scheme/language`.
Neither demo is a general-purpose security sandbox.

Playground recovery uses the existing durable-tool replay protocol for both
languages. Lua commands use fresh Wasm instances and portable VM state between
steps; this does not claim that Playground persists a Lua continuation as an
authority checkpoint. The separate Execution inspector exercises that integration.

## Keep this matrix honest

When adding a capability, update its authoring reference, add a test through the
public tool and real journal, then update this table with the test path. A kernel
experiment is not demo support until the Playground adapter consumes it. For
runtime placement changes, add or run workerd recovery coverage. For authoring
changes, submit the same natural-language task through each composer selection
with a real model, inspect the authored source, interact, reload while waiting,
and verify the completed result. Record provider, runtime, thread URL and evidence;
never count a scripted model as app validation.

Run `pnpm -C apps/yo-workflow test`, `pnpm -C apps/yo-workflow check`, and `pnpm land`
for a broad change. Compiler/kernel changes additionally require their local
conformance suites. Record failures and not-run gates separately.

## Browser evidence, 2026-10-20

Local Cloudflare/workerd, OpenCode `claude-haiku-5-5`, medium reasoning. Literal
message: `lets play paper rock scissors`. No authored source was supplied by the
operator. The model generated the game.

- Scheme baseline thread: `5d9d374d-6375-4220-b36c-0d92e784a649`. Two rounds,
  win then tie; pending state survived reload; quit produced the correct score.
- Selector thread: `049b9b94-9485-4ee4-a9e6-981adfed56b4`. Lua selected in the
  task composer, model validation then execution, rock lost to paper, reload
  preserved the result and pending next throw, quit completed. The same message
  was then submitted with Scheme selected in the same thread: paper tied paper,
  pending state survived reload, and quit completed with the correct one-tie score.

This is targeted real-provider coverage, not a claim that `pnpm land:live` passed.

Validation for this change: app test suite 90/90, final focused suite 24/24,
Astro/TypeScript check passed, app lint passed with warnings. Full landing stopped
at stage 2 (repository lint) on seven pre-existing scoped-handoffs lint errors;
stages 3–22 did not run. Summary:
`.artifacts/landing/2026-10-20T07-48-30-028Z-deterministic/summary.json`.
The summary's `PROVIDER_AUTH_FAILED` classification is incorrect: the actual
errors are missing braces and a conditional-spread comment in the experiment.
Browser snapshot: `.artifacts/workflow-language-selector/browser-evidence.json`.

## Execution inspector parity

The Execution page preserves its confirmation demo: a model-authored caller invokes
`review_draft`, waits for approval and suspended `ensure` cleanup, then invokes the
uncompiled `send_announcement` host tool. The language selector controls both caller
authoring and execution. Both developer artifacts come from the same TypeScript
`apps/yo-workflow/execution/review-draft.workflow.ts`; the SDK
DurableTool export remains distinct from those compiled artifacts.

| Capability | Scheme Execution | Lua Execution | Source and evidence |
| --- | --- | --- | --- |
| Same compiled TypeScript tool and host-tool interop | Supported | Supported | `tsdown-authoring/tsdown.config.mjs`, `tsdown-authoring/__tests__/runtime.mjs`; app `execution/{scheme,lua,service-core}.mjs` |
| Approval, decline, cancellation, suspended ensure cleanup | Supported | Supported | App `execution/__tests__/service.mjs`; `lua-compiler/__tests__/runtime.mjs` also covers throw and cleanup failure |
| Fresh-instance checkpoint restore at approval and cleanup | Supported | Supported | Artifact runtime tests; real workerd browser runs below |
| Source, call stack, raw checkpoint, boundary timeline | Supported | Supported | `src/execution/ExecutionInspector.tsx`; Hoot inspection tests and `flowmode-runtime-lua` kernel inspection |
| Lexical environments and scope/unwind projection | Supported | Not implemented | `ExecutionInspection.availability`; Lua explicitly reports unavailable |
| Scoped scheduler and durable timers | Not integrated | Not integrated | Separate `scoped-handoffs` experiment; timer driver not implemented |

Execution lifecycle traces use kernel/execution middleware for both languages
(`execution/diagnostics.mts`). The shared runtime composes middleware around the
existing live handle; adapters no longer emit observer callbacks. Optional
`execution.inspect()` supplies detached evaluator diagnostics on demand. Scheme
projects its machine snapshot; Lua projects portable state and continues to mark
lexical environments and unwind inspection unavailable. Middleware failures
propagate; diagnostics never authorize checkpoint restoration.

For changes here, run `pnpm -C apps/yo-workflow execution:test` as well as app checks.
Retain the same developer source and public tool contracts across languages; do not
replace the compiled artifact with a handwritten equivalent. Browser validation
must restore at both suspension points, observe an empty outbox during cleanup,
and verify one host receipt after release.

`src/__tests__/execution-composition.acceptance.test.ts` drives the public
Execution service through Test Rig's in-process and HTTP bindings. Both languages
retain approval and cleanup across service replacement with the journal and
serialized app state preserved, settle cancellation, and produce one host receipt
only after cleanup release. The same suite verifies operation middleware observes
fresh and restored executions. Its fixture compiles the real SDK developer tool
through the public compiler packages; it supplies deterministic caller source,
not a model-authoring or browser-validation claim.

### Execution browser evidence, 2026-10-20

Local Cloudflare/workerd with the `ExecutionLab` Durable Object and D1, real OpenCode
`claude-haiku-5-5` (medium). Both used the unchanged message:
`Review the launch announcement, and if I approve it, send it to Sam.`

- Scheme run `a38aa319-7e8c-4a32-9e4c-c0905f8a6d11`.
- Lua run `7053f06e-a59d-4467-9b30-43938fea27ba`.

Both completed approval → fresh restore → approve → cleanup → fresh restore →
release. Each recorded two verified restores, one kernel start, and exactly one
announcement receipt. Reload retained completed state. Captured API views are in
`.artifacts/execution-language-parity/{scheme,lua}.json`.

Execution/compiler suites and 90 app tests passed; scoped lint passed with warnings.
Full landing stopped at repository lint on the same seven pre-existing
scoped-handoffs errors; stages 3–22 did not run. Summary:
`.artifacts/landing/2026-10-20T08-16-59-807Z-deterministic/summary.json`.
The provider-auth classification in that summary is incorrect; this is lint.

## Second-pass review and validation

The authoring policy now takes the selected language explicitly, and request
construction replaces an existing language header instead of appending another
value. The selector regression test covers that case. Scoped experiment lint and
formatting issues were corrected without changing assertions or semantics.

Validation on 2026-10-20:

- App suite: 90/90; execution/compiler suite: passed; scoped suite: 26/26;
  native shared-checkpoint suite: 2/2; app and scoped types passed.
- Full gate first exposed a PostgreSQL test-harness output mismatch: setup reset
  the selected isolated database, but the consumer did not recognize its printed
  URL and tests fell back to another server. The harness now emits the expected
  URL and fails closed when no URL is returned. PostgreSQL passed 17/17 both
  independently and in the corrected full run; conformance assertions unchanged.
- Corrected `pnpm land:full` passed stages 1–10, including repository lint,
  package/test/app types, tooling, hygiene, clean build and formatting. Stage 11
  reached its existing 900-second whole-stage limit with package concurrency 2.
  Normal platform acceptance passed 109/109; SQLite cases were still passing
  immediately before termination. Stages 12–24, including live validation, did
  not run. Durable-streams retained its 19 existing skips; this is not Redis
  certification. No timeout was increased in this review.

Full summary: `.artifacts/landing/2026-10-20T08-41-08-344Z-full/summary.json`.
Narrow logs: `.artifacts/workflow-second-pass/`. The earlier real-provider browser
runs above remain targeted evidence, not a passing full live gate.

## Automatic compiler integration

The shared frontend and Scheme/Lua targets now live in `packages/flowmode-compiler*`.
Execution's Cloudflare worker imports the ordinary SDK tool; `workflowPlugin()` in
Astro's Vite configuration attaches both artifacts, and the selected language
chooses its compiled definition. The Node conformance adapter retains standalone
artifact imports to verify compiler-free artifact consumption.

The Vite tests exercise edits, invalid source, recovery, type dependency changes,
inline execute generators and production builds. Persisted Execution runs pin the
program digest and explicitly reject loading changed code (`workflow_source_changed`).
This adds no hot migration of continuations and promotes no experimental evaluator,
structured scheduler or timer capability.

## Runtime package ownership

`flowmode-runtime-lua` owns the Piccolo VM, evaluation port, portable state codec,
kernel and replay loop. The app retains capability schemas, sampling/decision
policy, authoring prompts and UI events. `flowmode-runtime-scheme` owns both the
existing Playground session evaluator and the separate Execution checkpoint
kernel. This package move does not replace either Scheme language implementation.
Both runtime packages own reproducible Wasm build inputs and generated assets;
app loaders no longer depend on experiment build output directories.

The shared backend still uses `createWorkflowProgramDriver`. Playground recovery
remains durable-tool replay; Execution remains the continuation-checkpoint consumer.
No scheduler, timer, or additional Lua inspection capabilities are introduced.

## Runtime promotion validation, 2026-10-21

Real-provider T3 collaborative-browser checks used local Cloudflare/workerd,
OpenCode `claude-haiku-5-5`, medium reasoning, with the promoted package assets.

- Execution Scheme `66ce907f-e19a-4cf1-b9ec-f7378caae41d` and Lua
  `5e217be9-b52a-41e2-8bef-6b98dc19428b` used the unchanged natural-language
  announcement prompt. Each passed approval → restore → approve → cleanup →
  restore → release, retained completion after reload, and recorded one kernel
  start, two verified restores and exactly one announcement receipt. Outboxes
  stayed empty while cleanup was pending. Lua reports cleanup inspection as
  unavailable and exposes raw VM state.
- Playground used the built-in Bulls and Cows natural-language example in both
  languages. Scheme thread `02c352c6-cd73-4c66-a9ae-eeb6f0ed1798` and Lua thread
  `92daa8e1-a4e7-4edd-bff7-d01cc1adb50a` preserved pending questions on reload,
  advanced 1023 → 1204 after one bull and two cows, and settled cancellation back
  to Ready across another reload. Scheme's first authored program tried to read
  `schema` from a string input; the recorded `E_EXPECTED_OBJECT` diagnostic let
  the model repair it. The repaired program passed the flow. Lua required four
  normal computation approvals, two before each guess; fuel policy was unchanged.

Evidence: `.artifacts/runtime-promotion/{scheme,lua}-execution.json`,
`{scheme,lua}-playground.json`, and `summary.md`. Both Wasm builds and package
checks passed; rebuilt Scheme Playground assets matched the tested bytes and
Lua rebuild verification passed. App tests passed 99/99 with one worker,
including workerd recovery; app types, runtime/compiler conformance and Vite
checks passed. Earlier concurrent heavy runs hit unchanged Scheme test deadlines;
isolated runs passed without weakening assertions or extending timeouts.

Fresh PR validation repeated real-provider computer-use checks after committing:

- Execution Scheme `614e1cf4-27e3-4c1a-8d25-d9910335ab88` and Lua
  `7b5983b7-49bc-476f-8e16-ec2bf6798d00` each completed the approval, two verified
  restores, cleanup and release flow with one receipt; completion survived reload.
- Playground Scheme `f62b4255-2d36-4987-9d28-b23819a6a3fa` and Lua
  `599df8ea-fba2-494e-b14a-de636336d5c3` advanced 1023 → 1204 after feedback,
  preserved both pending guesses across reload, and returned to Ready after
  cancellation and another reload. A browser transport disconnect during Lua's
  wait recovered on reconnect; the expected next guess was present.

Fresh evidence: `.artifacts/runtime-promotion/pr-{scheme,lua}-execution.json`
and `pr-{scheme,lua}-playground.json`; the Execution flows were also recorded.

All 23 `pnpm land` stages passed in 38m35s, including 99/99 yo-workflow tests.
Summary: `.artifacts/landing/2026-10-21T20-24-51-251Z-deterministic/summary.json`.
The run used disposable PostgreSQL and Redis instances. Earlier attempts stopped
at the occupied default PostgreSQL port and then at Redis coverage (19 skipped
versus a baseline of 17 while Redis was unavailable). Providing isolated services
resolved both issues without changing expectations, skip baselines or timeouts;
all 20 Redis tests ran and passed. The existing PostgreSQL service was untouched.
Owned app and test services were stopped after validation. Broad `land:live` was
not run; the live evidence above is targeted real-provider computer use.

## Python Playground

The language selector now exposes Python to the authoring model through the
`python` durable tool (`src/workflow/python/tool.ts`). It executes ordinary
`async def main()` code using real `from sandbox import ask, random, ...` imports.
The shared Ask, Echo, Random, Sample, Decision and document contracts are supplied
by the host. Each accepts one request dictionary; Ask returns its existing
accept/decline/cancel envelope. This is separate from the fixed `/execution`
read-file example and its intentionally disabled model-authoring control.

The host journals compressed Monty snapshots at compute boundaries and disposes
the Wasm instance before waiting for a capability. Replaying an accepted turn
reuses its recorded result; it does not redraw randomness or repeat a human
question. The tool identity includes the runtime identity and capability bindings.
Node and workerd install the same evaluator, with their respective module loaders.

`asyncio.gather` admits distinct capability calls concurrently. This first
Playground adapter services the frontier in admission order. Standard TaskGroup,
Queue, timers, arbitrary Python packages and filesystem access are not exposed.
Validation executes through the first host boundary without performing host
effects; later branches and request schemas remain unchecked. Native turn/time
and memory limits apply; there is no cooperative computation-approval UI yet.
The chat Stop command does not promise guest unwind; an Ask cancel action returns
to Python for explicit handling. Kernel cancellation and yielding cleanup are
separately tested.

Public evidence: `acceptance/__tests__/monty/playground.acceptance.test.ts` proves
random-result retention, Ask accept/decline/cancel, fresh-instance recovery,
gather and cancellation cleanup. `playground-cloudflare.acceptance.test.ts`
exercises the real model protocol (controlled provider), validation feedback,
generated Python tool invocation and Ask recovery across workerd replacement.
A live CLI-proxy run with gpt-6.1-sol also authored, validated, and completed a
rock-paper-scissors game after a browser reload on the pending Ask (2026-10-29).
The controlled-provider test remains the repeatable regression gate.
