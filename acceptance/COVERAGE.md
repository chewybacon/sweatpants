# Public framework acceptance coverage

Run every deterministic scenario with **`pnpm test:acceptance`**. The suite
collects 94 cases: 36 application composition, 10 recovery, 47 runtime contracts,
and one real host crash. Counts are collected test cases, not line coverage.

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
- **Host lifecycle:** graceful replacement closes and reopens the same SQLite
  file; SIGKILL destroys a separate Node host and a new process resumes the same
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
  `recovery/host-replacement`. Worker attachment/shutdown counts, fenced
  placement, child activity identity, journal facts and private-history checks
  are preserved.
- `nested-failure.acceptance.test.ts` (3):
  `application-composition/nested-failures`.
- `host-replacement.acceptance.test.ts` (1): `recovery/host-replacement`.
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

These are 59 removed source cases. They also remove 21 redundant SQLite lane
reruns. The old platform collection is now 43 memory / 14 SQLite / 9 process;
its retired 13-case tool-loop lane has no script, landing stage or baseline.
The new package remains included in the ordinary package test gate.

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
