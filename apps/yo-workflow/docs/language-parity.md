# Playground language parity

The composer selects the language for the next task. The message stays unchanged.
`src/chat/authoring.ts` sends the selection and language-specific authoring policy;
`src/server/cloudflare.ts` selects the model-facing inventory through
`src/workflow/agent.ts`. Both durable tools remain registered so earlier work can
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
supported forms and procedures are generated in `@sweatpants/scheme-runtime/language`.
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
`experiments/workflow-kernel/tsdown-authoring/review-draft.workflow.ts`; the SDK
DurableTool export remains distinct from those compiled artifacts.

| Capability | Scheme Execution | Lua Execution | Source and evidence |
| --- | --- | --- | --- |
| Same compiled TypeScript tool and host-tool interop | Supported | Supported | `tsdown-authoring/tsdown.config.mjs`, `tsdown-authoring/__tests__/runtime.mjs`; app `execution/{scheme,lua,service-core}.mjs` |
| Approval, decline, cancellation, suspended ensure cleanup | Supported | Supported | App `execution/__tests__/service.mjs`; `lua-compiler/__tests__/runtime.mjs` also covers throw and cleanup failure |
| Fresh-instance checkpoint restore at approval and cleanup | Supported | Supported | Artifact runtime tests; real workerd browser runs below |
| Source, call stack, raw checkpoint, boundary timeline | Supported | Supported | `src/execution/ExecutionInspector.tsx`; Hoot inspection tests and Lua `kernel.mts` inspection |
| Lexical environments and scope/unwind projection | Supported | Not implemented | `ExecutionInspection.availability`; Lua explicitly reports unavailable |
| Scoped scheduler and durable timers | Not integrated | Not integrated | Separate `scoped-handoffs` experiment; timer driver not implemented |

For changes here, run `pnpm -C apps/yo-workflow execution:test` as well as app checks.
Retain the same developer source and public tool contracts across languages; do not
replace the compiled artifact with a handwritten equivalent. Browser validation
must restore at both suspension points, observe an empty outbox during cleanup,
and verify one host receipt after release.

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
