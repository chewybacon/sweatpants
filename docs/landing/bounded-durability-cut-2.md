# Bounded durability closure — Cut 2 landing record

## Commit

- `32d16a7` — Host-owned Turn scope, production terminal authority, Session History publication, and terminal-unpublished recovery.

## Added and changed paths

- Added `journal-authority/turn-authority`: bounded Turn open/complete/read/fact-frontier/mark-published operations over `ExecutionStoreApi`.
- Added `chat-core/projection-facts`: the chat-owned terminal Projection Fact and projector contract.
- Extended durable-execution's generic contract with `ProjectionFactEnvelope`.
- Extended `durable-chat-runtime` publication orchestration with active-Turn selection, terminal commit, immutable history publication, Session Head CAS, capsule marking, and recovery.
- Added the concrete `DurableTurnOwner` lifecycle under the Host composition scope.
- Switched response writers to the invocation's Turn owner; cleanup remains supervised and writer teardown remains structural.
- Changed production durable-stream setup to fail closed without an explicit Host/Turn owner.
- Updated the production handler and ProgramRuntime chat engine so terminal publication completes before `RUN_FINISHED`/final response closure.
- Updated standalone handler tests to compose an explicit Host and Turn.

No compatibility path, forwarding export, parentless production task, or distribution-boundary bind was added.

## Production caller and residue searches

```text
ModelProviderPort.bind / ToolRuntimePort.bind in production       => 0
parentless createScope() in handler/response-stream production    => 0
completeAndPublishTurn production callers                        => 1
createDurableTurnOwner production callers                        => 1
explicit ownerless durable-stream setup guard                     => present
```

The production tree is now:

```text
Host composition scope
  └─ selected Turn scope
       └─ response writer
            ├─ ProgramRuntime crank
            ├─ model/tool/child work
            └─ terminal authority + publication

HTTP/SSE request scope
  └─ response-buffer subscription only
```

The authority-visible active execution is selected after request normalization and before the structural Turn owner is created. Model provider, optional tool runtime, program/effect registries, policy, writer, crank, and publication resolve from or execute beneath the Turn scope without binding.

## Terminal and publication evidence

- `createTurnJournal(executionId)` acquires a resource that opens one bounded execution, stores accepted Projection Facts behind the capsule frontier, commits a real `TerminalCapsule`, and marks publication idempotently.
- `publishTurn` reads only the capsule-named fact reference, validates execution/Session/Turn identity and contiguous sequence, writes immutable history, CAS-advances Session Head, and then marks the capsule published.
- The normal handler blocks final response completion while Session Head CAS is held; `RUN_FINISHED` appears only after release and successful publication.
- Production-style handler recovery after a fault immediately following Terminal Capsule commit publishes exactly one history entry and leaves provider invocation count unchanged.
- A fault after immutable segment creation reuses the same publication key/body without duplication.
- A fault after Session Head CAS but before capsule marking is recovered through `latestCompletedExecutionId`, returns `already_published`, and repairs capsule metadata.
- Supersession publishes the prior bounded Turn as `superseded` before selecting and running the replacement Turn.
- The terminal-unpublished path invokes no ProgramRuntime operation, provider, tool runtime, child execution, or chat crank; it only reads accepted authority output and writes projection state.

## Narrow tests

- Journal Authority: 13 passed, including terminal authority identity/frontier/idempotency cases.
- Durable Chat Runtime: 93 passed, including five structural Turn-scope cases and six publication/fault cases.
- Chat Core: 75 passed, including bounded-context Projection Fact projection/rejection.
- Framework: 315 passed, 4 live-only skipped, 7 todo; handler publication ordering/recovery and static bind/owner checks passed.
- Platform Acceptance: 82 passed, including reconnect, cancellation/supersession, graceful shutdown, host replacement, nested child/tool, and HTTP/in-process variants.
- Focused cancellation/graceful/reconnect corpus passed after the supersession publication ordering change.
- yo-chat tool-wiring test now composes an explicit test owner and all three cases pass.

## Graph, exports, clean build, and landing

- Root production typecheck passed.
- Strict test typecheck passed for 25 packages.
- Application typechecks passed.
- Package export validation passed for 26 packages.
- Product-surface validation passed: 14 facade paths, two product apps, one golden suite.
- Module graph passed: zero package cycles, zero architecture violations, and only the two pre-existing Framework module cycles assigned to Cut 3.
- Clean build, repository format, lint, generated artifact verification, all package/application suites, and deterministic yo-chat E2E passed.
- `pnpm land`: all 19 stages passed in 3m07s.
- Artifact: `.artifacts/landing/2026-07-29T10-01-15-421Z-deterministic/summary.json`.

## Live-storage evidence

Cut 2 intentionally wires terminal/publication semantics through Journal Authority before Cut 4 changes the production concrete persistence path. No Redis adapter or key layout changed in this cut, so the prior live-Redis evidence is not reused as Cut 4 certification. Memory and shared-memory replacement tests exercise the new authority/publication path; real-Redis bounded-store certification remains mandatory in Cut 4.

## Status

**Cut 2 complete.** Production durable chat work has a distinct Host-owned Turn scope, consumer scopes only read reconnect buffers, the two provisional production binds are deleted, real accepted terminal authority output is published before final close, and terminal-unpublished state recovers idempotently without rerunning execution.
