# Public framework acceptance coverage

Run every deterministic scenario with **`pnpm --filter @sweatpants/acceptance test`**. The suite
collects 132 cases: 39 application composition, 9 recovery, 48 runtime contracts,
13 protocol contracts, 18 Flowmode, 4 storage, and one real host crash. Counts are collected test cases, not line coverage.

## Guarantees

- **Tool validation and loops:** malformed JSON, invalid parameters before body
  entry, unknown tools, invalid declared outputs, thrown tool errors, correlated
  multi-call results, split arguments, preface text, mixed success/failure,
  sequential iterations, mixed ordinary/durable routing, iteration limits,
  retained call/error history and same-client recovery.
- **Plugin authoring:** typed interactions, named and generic nested sampling,
  multi-step UI within one elicit, transformed responses, Markdown, stable
  render identity, completed/pending states, successor sends, decline/cancel,
  provider error recovery and controlled scheduler batching.
- **Settlement and concurrency:** accept/decline/cancel facts restore in a fresh
  client; new duplicate and conflicting commands from a captured stale revision
  are rejected by the real HTTP server with no model/effect re-execution.
  Interleaved conversations isolate text, authority and failure.
- **Transport:** pre-stream error, partial failure, provider disconnect, oversized
  accepted partials, empty output, raw live/completed reconnect, and actual client
  disconnect/reconnect without duplicated text or another provider invocation.
- **Durability:** recorded effects, recording, sampling, elicit replay, all choice
  outcomes, exact-once follow-up call/results, pending identity and streamed
  narration after reload, cancellation during an elicit or nested provider call,
  host-effect failure and recovery.
- **Storage matrix:** the same real HTTP client/server scenario runs against
  memory kernel, SQLite, Postgres and local workerd D1. Fresh application and
  store compositions recover a parked tool, accepted recording, nested sampling
  and elicitation without repeating the recorded effect. SQLite opens a new
  connection to the same file; Postgres opens a new pool to a test-owned cluster;
  D1 keeps its caller-owned workerd binding. Memory keeps its kernel and makes
  no process-persistence claim.
- **Flowmode:** the TypeScript frontend and both target compilers consume an
  acceptance-owned authored durable tool. Lua and Scheme callers link that
  compiled tool and execute real Wasm. Both kernels restore JSON-roundtripped
  approval and cleanup snapshots in fresh instances, complete cancellation
  cleanup despite repeated cancellation, reject changed artifacts/incompatible
  snapshots, and diagnose malformed callers. The shared program driver and
  real journal recover both languages across all four storage backends without
  duplicating accepted pulls. Ordinary Lua replay separately uses real durable
  records without repeating accepted Wasm computation; the distinct Scheme
  session evaluator separately exchanges capability requests and JSON replies.
- **Host lifecycle:** graceful replacement closes and reopens storage; SIGKILL destroys a separate Node host and a new process resumes the same
  database. Crash evidence counts actual effect executions outside both process
  generations. Accepted history and one final result survive. These tests do not
  claim disk-loss or machine-power-failure coverage.
- **Local worker:** off-thread execution, context message counts (4 before / 6
  after named sampling), typed exchanges, metadata-only contract projection,
  strict pre-dispatch validation, render transformation, cancel/reconnect,
  fresh durable attachments at every park, shutdown counts, fenced activation,
  child activity identity, nested provider abort, drained invocation resources,
  and worker exit after an unacknowledged external operation without replaying it.
- **AgentCore adapter:** inventory/parameter projection, pre-dispatch validation,
  exact manifest lookup, remote evaluator replacement after park, replay/effect
  counts, journal parity and cancellation unwind. Transport is a deterministic
  adapter implementation; these cases do not certify AWS, IAM, SigV4 or live
  runtime availability. Existing opt-in live service tests remain separate.

- **Cloudflare adapter:** real local workerd Dynamic Workers and Durable Object
  execution, native RPC lifetime/cleanup, scoped setup, replay and effect counts,
  cancellation, malformed-command recovery, stale capabilities, ordinary-session
  deduplication and fail-closed workerd restart. No live Cloudflare account required.

- **Command identity:** exact retries of accepted ordinary elicitation commands
  return the current window without a new run; changed payloads under the same
  command ID fail with `command_identity_conflict`. Covers accept/decline/cancel
  separately from new commands using stale revisions.
- **Streaming primitive:** pull-based text/NDJSON, request body and custom headers,
  delayed and empty streams, setup failure, and cancellation cleanup. Cleanup is
  observed directly rather than waiting an arbitrary sleep.
- **MCP continuations:** typed form projection/context, accept/decline/cancel,
  identical retries, missing capabilities, argument/token tampering, invalid
  answers, concurrent duplicate settlement, conflicts, actual listening-origin
  validation, and one actual ordinary tool body execution.
- **Cancellation ordering:** cancellation of a durable parent aborts its ordinary
  child's scope-owned signal exactly once, does not continue the body, and
  journals child closure before parent resolution and closure.

## Replacement ledger

Old paths below are relative to `packages/platform-acceptance/src/__tests__/`.
All 12 files were deleted after their replacement assertions passed. HTTP is
now the shared semantic binding; real worker behavior is retained in dedicated
runtime cases rather than multiplying every semantic case across placements.

- `tool-loop.acceptance.test.ts` (13):
  `application-composition/tool-loops`, `tool-validation`, and `durable-tools`.
- `concurrency.acceptance.test.ts` (2):
  `application-composition/concurrent-conversations`.
- `provider-failure.acceptance.test.ts` (5):
  `recovery/provider-disconnect`; the oversized partial and empty-output cases
  are retained, not replaced by the simpler existing React error case alone.
- `reconnect.acceptance.test.ts` (1): `recovery/http-reconnect`.
- `stale-elicit.acceptance.test.ts` (6 binding-expanded cases):
  `application-composition/elicitation-responses` (three HTTP outcomes). The old
  tests assert `elicit_not_open`; the former coverage document's
  `RESUME_CONFLICT` description was inaccurate.
- `interactive-tool.acceptance.test.ts` (5): existing React booking and
  `tool-runtimes/local-worker/context`. The duplicate helper-guard assertion is
  superseded by actual server rejection, and worker context/pull identities
  and ordinary decline/cancel exchanges have explicit runtime assertions.
- `durable-tool.acceptance.test.ts` (5): `application-composition/durable-tools`,
  `durable-cancellation`, `tool-runtimes/local-worker/durable-lifecycle` and
  `storage/recovery`. Worker attachment/shutdown counts, fenced
  placement, child activity identity, journal facts and private-history checks
  are preserved.
- `nested-failure.acceptance.test.ts` (3):
  `application-composition/nested-failures`.
- `host-replacement.acceptance.test.ts` (1): `storage/recovery`.
- `pending-elicit-reconnect.acceptance.test.ts` (4 binding-expanded cases):
  `recovery/replay`, including preceding streamed narration; real worker
  reconnect also remains covered in its runtime folder.
- `process/cancellation.acceptance.test.ts` (4): ordinary worker interruption in
  `local-worker/exchange`, plus durable cancellation with both host-crank and
  worker execution. Provider abort and fresh-client recovery are explicit.
- `execution-boundary.acceptance.test.ts` (10 binding-expanded cases): existing
  booking, nested failures, worker context, and
  `local-worker/execution-boundaries`. The latter preserves second-question
  reconnect, actual resource drainage, and the external-attempt file proving
  an unacknowledged worker operation is not executed twice.

These were 59 removed source cases in the first migration, plus 21 redundant
SQLite lane reruns. At that checkpoint the platform collection was 43 memory / 14 SQLite / 9 process;
its retired 13-case tool-loop lane has no script, landing stage or baseline.
The new package is the acceptance stage of the four-gate `pnpm land` command.

Also transferred and deleted from their former owners:

- `tool-runtime-local/acceptance/strict-tool-parameters.acceptance.test.ts` (2)
  and `contract-projection.acceptance.test.ts` (4).
- `tool-runtime-agentcore/acceptance/strict-tool-parameters.acceptance.test.ts`
  (2) and `src/__tests__/durable-driver.integration.test.ts` (4).
- `tool-runtime-cloudflare/src/__tests__/executor.test.ts` (12) and
  `sessions.test.ts` (4), together with their Worker fixtures and public binding
  type proofs. All now live under `tool-runtimes/cloudflare`.
- The earlier React migration removed all nine expanded hook-state cases and
  their obsolete scenario, application, tool/plugin and worker fixtures.

## Retained suites

The remaining platform package covers additional protocol, projection/window,
message ordering, history, multimodal, MCP/A2A composition, graceful shutdown
and storage-spine contracts. StrictMode and specialized rendering remain in
React. Storage/codec/fencing/compiler unit and conformance tests remain with
implementation packages. No retained test is claimed as ported or redundant
without replacement evidence.

Some old shared platform fixtures still serve retained tests. They remain with
those consumers; the new package imports no old platform application fixture or
conversation/turn facade. AgentCore's driver conformance reuses the public
journal-authority testing contract, including its semantic-journal comparison;
provider-wire history assertions in authoring tests stay explicit.

## Shared contracts extracted from apps

All eleven app directories were audited. This pass extracts framework guarantees
only; acceptance imports no app source or app test harness. App-owned languages,
product flows, configuration and placement wiring remain with their apps.

- `apps/yo-chat/src/__tests__/hello-stream.test.ts` (8) →
  `protocols/streaming/handler`; old file deleted.
- `apps/yo-chat/src/__tests__/execution-spine-surface.test.ts` (1) →
  retired as a null-cast/symbol smoke; strict public imports and actual executed
  composition cases cover the useful surface. Old file deleted.
- `apps/yo-chat/acceptance/durable-cancellation-abort-signal.acceptance.test.ts`
  (1) → `tool-runtimes/in-process/cancellation-ordering`; old file deleted.
- `apps/yo-chat/acceptance/ephemeral-stale-elicit.acceptance.test.ts` (3) →
  `application-composition/command-retries`, using a minimal ordinary choice
  tool instead of booking fixtures; old file deleted.
- `apps/yo-mcp/src/__tests__/cli.acceptance.test.ts`: listening-origin and invalid
  continuation cases (2) → `protocols/mcp/continuations`. Removed those cases
  and the duplicated retry/response-stream assertions from the card outcomes.
  Card-specific result/schema checks, greeting, inventory/CORS/server wiring,
  and five-step trip revision/cancellation remain app-owned. New generic MCP
  cases explicitly retain all three outcomes and actual execution counts.

This pass removes 15 source cases in four whole files and two mixed-suite cases;
17 focused replacements add independent outcome coverage; the null-cast smoke
was retired. Yo Chat now collects 73 default cases; Yo MCP collects 12. No collection baseline was lowered.

| App                                 | Retained coverage and extraction decision                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yo-chat`                           | Extracted four framework-only suites. Booking/game behavior, actual app tools, host/Cloudflare/AgentCore placement, SQLite/env/routes/metadata/inspector, live and browser flows remain. Multi-generation game tests retain actual game-specific tool behavior and are not replaced by generic replay alone. |
| `yo-mcp`                            | Extracted origin/continuation guarantees and retry assertions; retained actual server middleware, tool inventory and authored product outcomes.                                                                                                                                                              |
| `yo-workflow`                       | Retained Scheme/Lua app tool adapters, language diagnostics, documents, fuel policy, execution inspector/service HTTP API, Cloudflare app composition and UI. These consume app-owned code rather than generic package fixtures.                                                                             |
| `yo-studio`                         | Retained workspace authoring, real file/script mutations, conversation workspace affinity, deployment and session identity.                                                                                                                                                                                  |
| `yo-agent`                          | Retained app-owned terminal interaction runtime and ask-user plugin behavior.                                                                                                                                                                                                                                |
| `storage-inspector`                 | Retained inspector API privacy/redaction and SQLite query behavior.                                                                                                                                                                                                                                          |
| `agentcore-tool-session-tracer`     | Retained deployment protocol/session registry, tool inventory and internal model-selection configuration.                                                                                                                                                                                                    |
| `agentcore-durable-program-runtime` | No deterministic cases to extract; deployment-specific opt-in certification scripts remain.                                                                                                                                                                                                                  |
| `lambda-durable-program-runtime`    | No deterministic cases to extract; deployment entry/build configuration remains.                                                                                                                                                                                                                             |
| `lambda-microvm-sandbox`            | Parked deployment shell; no deterministic cases to extract.                                                                                                                                                                                                                                                  |
| `yo-slides`                         | Documentation/presentation app; no framework tests to extract.                                                                                                                                                                                                                                               |

## Duplicate-suite trimming

The worker session suite now has five focused cases, replacing 17 broad cases
and deleting its 832-line child-process/polling harness. Its actual workers
still run; only the extra parent Node process per scenario and duplicate flows
are removed. The fixture registry retains only tools used by those five cases
or the separate local driver smoke tests.

| Former worker cases                                                                                       | Retained guarantee                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Echo/result, ordinary elicit acceptance, first/second-stage decline and cancel, two-elicit booking/result | Central `local-worker/exchange`, `context`, and parameter/projection cases exercise real workers. Branch-specific booking results are fixture business logic; the transport outcomes remain covered. |
| Missing remote tool                                                                                       | Focused worker session test retains remote registry failure and failed status, distinct from host inventory validation.                                                                              |
| One sample; repeated samples                                                                              | Rich sample exchange plus three sequential requests with unique IDs and exact returned values.                                                                                                       |
| Sample followed by elicit; two identical context fixtures                                                 | One worker sample-to-elicit case asserts awaiting states, response schema, complete nested context and final selected value.                                                                         |
| System prompt, token budget, model preferences, model identity                                            | Preserved exactly in the sample-to-elicit boundary case.                                                                                                                                             |
| Structured response schema/parsed result; sample tool definitions/choice/returned calls                   | Two focused wire exchange cases preserve all original assertions.                                                                                                                                    |
| `afterLSN` replay                                                                                         | Three samples plus result have exact LSNs 1–4; replay after 2 returns exactly events 3–4 and terminates, without a timed partial collection.                                                         |

Platform trimming retains **28 memory / 2 SQLite / 9 process** cases:

- Removed old `history`, `streaming`, and `conversation-admission` files after
  strengthening the central booking/streaming/retry cases. Exact tool arguments,
  causal user/call/result/assistant/user order, nested-text privacy, streaming
  deltas before completion, one durable assistant-text emission, stable assistant
  identity without duplicate snapshots, and typed parked admission remain explicit.
- Removed repeated in-process profiles for timeline, window, multimodal and
  nested-ownership scenarios. Their unchanged behavioral assertions run over
  HTTP; dedicated in-process composition/model-placement tests remain.
- Run ordinary/durable multi-turn timeline cases once on SQLite, excluding them
  from memory. Remove broad SQLite reruns of history/admission/window scenarios;
  retained SQLite replacement/crash, caller-owned storage, adapter conformance,
  and all nine process cases cover persistence-specific guarantees.
- Retired the Yo Chat `expect(true).toBe(true)`, the central null-cast surface
  test and the redundant platform symbol-only facade smoke. The actual product
  facade golden-path scenario remains.

No new public test command or implementation behavior changed. Baseline changes
match only the actual reduced platform collections; no unrelated floor changed.

## Flowmode and storage scope

The storage recovery scenario moved from `recovery/host-replacement` into the
four-backend matrix at `storage/recovery`; its existing assertions remain.
Flowmode compiler admission, helper/import, evaluator language, fuel, adapter
atomicity/rollback, database conformance and process contention suites stay with
their packages. These acceptance rigs do not replace those finer guarantees.
No package-owned tests were deleted in this pass.

The Flowmode storage matrix reconstructs authority/program/driver instances over
the same open storage connection. The separate HTTP storage matrix additionally
closes and reopens SQLite connections and Postgres pools during host replacement.
Neither matrix claims a process crash; `host-crash/` retains that explicit scope.
