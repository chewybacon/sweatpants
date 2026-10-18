# Agent Instructions

## Architecture Orientation

Read this before changing anything under `packages/`. It exists because the
package names follow their owned ports, while several similarly named placement
types remain intentionally unrelated.

### The four placement axes

A request moves through four independently replaceable boxes. Most confusion
comes from collapsing box 3 and box 4, which run different code under different
constraints.

| box                   | decides                                                             | port                                                                         | live implementations                                                                                            |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Ingress            | where HTTP lands                                                    | `createChatApplication` (`agent-host/src/server`)                            | Node HTTP (`apps/yo-chat`)                                                                                      |
| 2. Journal authority  | where truth lives; the serialization domain                         | `JournalAuthorityPort` (`journal-authority/src/contract/authority-ports.ts`) | `createJournal(store, options)` resource over Execution Stores; `createInMemoryJournal` for in-memory authority |
| 3. Crank / activation | where the durable program generator runs; chatty with the authority | `ProgramRuntime`, `handler/durable/local-program-host.ts`                    | in-process (Node)                                                                                               |
| 4. Tool execution     | where tool code runs; never touches the journal                     | see the two tiers below                                                      | see below                                                                                                       |

Box 4 has two tiers, and they are different ports:

- **Tier A — remote generator, no machine.** `ProgramDriver` (`durable-execution`):
  `attach / step / checkpoint / restore / shutdown / restoreContext? / manifest?`. Replays
  from the journal and runs to the next park point. No shell, disk, or ports.
  Implementations: `createWorkflowProgramDriver` (`journal-authority/src/workflow/program-driver.ts`),
  `tool-runtime-local` (`durable-driver.ts`, `local-worker-durable-driver.ts`),
  `tool-runtime-agentcore/src/durable-driver.ts`, `a2a/src/driver.ts`.
- **Tier B — a machine with a disk.** `SandboxProvider` (`workspace-runtime/src/sandbox-substrate.ts`):
  `create / inspect / connect / suspend? / resume? / restore? / terminate`, plus
  `SandboxCapabilities` (`shell`, `processExecution`, `localDisk`, `ports`,
  `workspacePersistence`). **This port has no implementations.** It is design
  stage; treat any first implementation as unproven, not as a second impl.

Because Tier A stops at park points, a single-invocation executor is a natural
fit for it. Long unparked work lives in box 3, not box 4.

### Program execution backends

`ProgramDriver` is the existing attachment/transport protocol; `ProgramBackend`
is the computation implementation inside the shared in-process driver. Do not
add a parallel driver solely to run another language.

- `journal-authority/src/workflow/program-backend.ts` declares `ProgramBackend`
  and `ProgramComputation`, and prepares the ordinary Effection kernel.
- `createWorkflowProgramDriver` accepts a durable-tool registry (Effection) or an
  explicit backend. `openProgramAttachment` owns pending operations, receipt
  checks, authorization, and command ordering for both.
- `program-backend-kernel` adapts `WorkflowKernel` to that computation contract.
  It translates evaluator requests; the attachment owns the shared execution loop.
  Experimental Hoot and reference evaluators consume it; production yo-workflow's
  existing Scheme runtime has not been replaced by these experiments.
- `durable-execution/src/program-recovery-policy.ts` supplies replay defaults and
  scoped checkpoint acceleration. Authority-plan validation surrounds middleware.
- Backend snapshots contain computation state. The shared driver adds protocol
  position and identity; the authority adds accepted journal provenance.

Dependency direction: `program-backend-kernel` → `journal-authority` and
`workflow-kernel`; the shared runtime does not import kernel backends or Wasm.

### Names that look related but are not

- `SandboxProvider` (`workspace-runtime`) — the Tier B runtime port. No impls.
- `SandboxProviderDefinition` (`agent-host/src/deployment`) — a _deployment
  descriptor_ (`image`, `lifecycle`). Produced by `lambdaMicrovm()`. Unrelated
  to the port above.
- `LambdaMicrovmWorkspaceManager` (`workspace-lambda-microvm`) — a workspace lease
  manager (`resolve / inspect / close`). Also unrelated to the port above.

### There are two chat engines, and both are live

They serve different product surfaces. Fixing one usually means considering the
other.

- `durable-chat-runtime/src/durable-handler/program-driver-chat-engine.ts` — the
  HTTP chat Turn reached via `createDurableChatHandler`; this is what yo-chat runs.
- `chat-core/src/authoring/program.ts` — authored/generated chat programs for
  A2A-served agents, reached through Agent Host's standard A2A composition.

### Configuration traps that make a wrong setup look right

Each of these has silently cost real debugging time. Prefer failing loudly over
falling back.

- **`dist` vs `src`.** App tests resolve `@sweatpants/agent-host` to `dist/`, so
  edits to Agent Host source have no effect until `pnpm -C packages/agent-host build`.
  The `development` export condition resolves to source; `packages/a2a`
  certification fixtures use `--conditions=development`.
- **Redis execution storage is uncertified.** Its current conformance output
  explicitly says `memory-fake (NOT Redis semantics)`. Do not use it as
  production authority until a real-Redis lane is approved and green.
- **Worker vs in-process ToolSession registry.** Production `tool-runtime-local`
  requires a worker-backed registry (`driver.ts`). Tests that build an
  in-process registry exercise a configuration that never ships.
- **SQLite persists between runs.** Product apps default to local SQLite.
  Tests must select explicit memory or a unique temporary `SWEATPANTS_DB_PATH`
  so durable state cannot leak across runs.

### Durability model in one paragraph

The journal is the only authority. Everything else — hosts, runtimes,
sandboxes, transports — is replaceable compute. A host may be destroyed at any
time; work the authority accepted survives, and work it never accepted was
never promised. Unsafe effects whose attempt is detached settle as a coded
`effect_outcome_indeterminate` outcome that the authored program acts on; there
is no state where a pull parks with no exit. `apps/yo-chat/acceptance/`
demonstrates this: the harnesses model host loss by discarding a runtime while
the substrate keeps journal, stream buffers, and foreign sessions.

## The No-Sediment Rules (pre-release)

The codebase is the current specification, not a history of discarded
approaches. History lives in git and `.pi/specs/archive/` — never in code.
Five rules, ratified 2026-08-31 (spec:
`.pi/specs/code-is-spec-simplification-spec.md`):

1. **Code is spec.** Every retained line must be justifiable by a currently
   ratified requirement — never by history ("this used to be needed").
2. **A cut lands with its delete.** When a requirement supersedes an
   implementation, the superseded code is deleted in the same change. No
   deprecation periods, no `@deprecated` markers, no alias/re-export shims,
   no parallel old/new paths beyond one change.
3. **One-change vocabulary renames.** When understanding renames a concept,
   the old name is deleted across code, tests, error codes, and ratified
   docs in the same change. One concept, one name.
4. **Reset-and-rebuild is the prerelease data policy.** Generated Drizzle
   migrations and their runners are useful schema tooling, but do not promise
   compatibility with old data. Local databases and migration baselines may be
   destroyed and regenerated. No legacy version guards, dual-read schemas,
   preservation migrations, or best-effort recovery. Format changes stay free.
5. **Consumer-or-parked.** Every workspace member either has a source-level
   consumer or carries an annotation in the tracked `docs/workspace/INDEX.md`
   member ledger (product / docs / parked / infrastructure). The gate
   (`pnpm check:hygiene`) enforces this; `scripts/campaign-evidence.ts`
   re-verifies deleted identities stay deleted.

**License expiry:** these freedoms expire the first time an external user
holds data they care about. From that point, a compatibility policy
specification MUST exist before any further data-format change.

## Quality Gates and Definition of Done

A coding task is not done until the relevant quality gates for the touched code have passed or any remaining failures have been clearly explained to the user.

### Fast Iteration Gates

Use the narrowest deterministic tests while implementing:

1. Run package-local unit tests for packages you changed.
2. Run package-local acceptance tests for affected contracts.
3. Run type checks for touched packages/apps when the change affects TypeScript APIs or exports.
4. Run generated-artifact verification when generated files or generators are touched.

Acceptance tests are the preferred fast feedback loop for framework/package contracts. They are meant to be narrower and faster than full browser e2e while still exercising public or near-public implementation boundaries.

### Test Code Style

Unit tests live in a `__tests__/` folder beside the code they test, at every level of the source tree; behavioral test names that don't mirror a source file are fine. Two further folders refine that placement: `__tests__/process/` holds files whose assertion target is another OS process (exit codes, signals, restart generations, cross-process contention), and `__tests__/fixtures/` holds spawnable helper programs (not modules under test).

Tests are read months or years later to answer "what does this guarantee and why?". Top-to-bottom narrative clarity outranks DRY: repeating setup inline across tests is preferable to hiding the scenario behind abstraction. Extract helpers only for mechanical harness work (temp directories, process lifecycle, dependency wiring that no test asserts on) or named semantic operations that tests assert _through_ — never for the arrange-act-assert flow itself. Assertions belong in the test body where the reader can see them.

### Acceptance Test Policy

Acceptance tests are contractual. They should pass as written.

Framework acceptance tests under `packages/platform-acceptance` MUST use the causal generator-based `withTestScenario` authoring style by default. Read `packages/platform-acceptance/AUTHORING.md` before adding or changing those tests. Promise barriers (`withTestRig`, `expectRequest`, raw turn handles) are an advanced escape hatch and require an inline explanation of why the scenario vocabulary is insufficient. Future feature specs and plans SHOULD present framework-acceptance examples in cause-then-consequence scenario form.

Do **not** modify acceptance test expectations merely to make an implementation pass. Changing an acceptance test expectation requires explicit user approval and should normally be paired with a deliberate contract/design/spec update.

If an acceptance test consistently fails:

1. Treat it as a likely implementation regression first.
2. Investigate and summarize the failure.
3. Discuss the contract ambiguity or implementation issue with the user.
4. Do not work around the test by weakening assertions, adding skips, or changing expected behavior without approval.

### E2E Tests: Land the Plane

```bash
pnpm land       # mandatory deterministic landing gate
pnpm land:live  # provider/model-dependent validation only
pnpm land:full  # deterministic followed by live validation
```

`pnpm land` is the default definition of landed for broad, risky, multi-package, or browser-visible changes. It runs generated checks, types, lint, build, package-owned tests with bounded dependency-aware concurrency, and isolated app tests. Chat semantics—including deterministic AG-UI ordering, elicitation state, replay, and durable tool behavior—are covered by Test Rig and React/jsdom acceptance; browser E2E is optional presentation coverage. Third-party MCP Inspector UI checks are opt-in (`pnpm -C apps/yo-mcp test:inspector`); MCP protocol/backchannel behavior is part of package acceptance.

Live-provider tests are separate because auth, provider availability, and model behavior are not deterministic. Run `pnpm land:live` when provider/model integration changed or the user explicitly requests live confidence. Use `pnpm land:full` when both are required.

#### Landing failure rules

- Stop at the first failed stage. Do not continue gathering unrelated failures.
- Do not increase a timeout after the first timeout failure.
- Do not run an identical failing command more than twice. A second identical failure requires a new diagnosis or user input.
- Auth, port, configuration, generated-artifact, module-resolution, and deterministic assertion failures are not model-latency problems.
- Skipped Playwright tests do not satisfy landing coverage.
- Never claim `pnpm land` passed when only a subset or live-provider suite ran.
- Full logs belong under `.artifacts/landing/<run>/`. Read the bounded failure tail first; do not load complete logs into agent context unless the bounded diagnostics are insufficient.
- Timeout changes require concrete evidence of forward progress immediately before the deadline. Never escalate timeouts speculatively.

### Tool Composition

Tool composition is code-first: applications author explicit tool lists and a
hand-written worker entry (see `apps/yo-chat/src/server/worker-tools.ts` and
`tool-worker.ts`). The Vite plugin's discovery/codegen is optional convenience,
not the blessed path; `@sweatpants/vite-plugin`'s `nodeWorkerPlugin` remains
required for `?modulePath` worker URL resolution.

## Effectful Boundaries: Ports, Drivers, Middleware

Effectful boundaries are declared once as a **Port** using `definePort` from
`@sweatpants/foundation/port`. The declaration is simultaneously the contract
type, the runtime operation list, and the fail-closed default. No Context is
exported, so callers cannot reach around the seam to an installed driver.

```ts
export const ExecutionStorePort = definePort<ExecutionStore>("execution-store", {
    *loadControl(_executionId): Operation<ExecutionControl | null> {
        return unavailable();
    },
});

yield * ExecutionStorePort.installDriver(createMemoryExecutionStore());
yield * ExecutionStorePort.api.operations.loadControl(id);
```

Rules:

- Drivers install at `at: "min"` (handled by `installDriver`) so policy and
  observation middleware, which default to `at: "max"`, always surround them.
  Installation order between a driver and middleware does not matter.
- Installation is bound to the current Effection scope: inherited by children,
  shadowable by a child, isolated between concurrent siblings, and discarded when
  the scope exits. See `packages/foundation/src/port.test.ts`.
- Exactly one driver per scope. Unlike `Context.set`, a second `installDriver`
  in the same scope does not replace the first, so it is rejected. Override by
  installing in a child scope.
- Port members must be functions. `createApi` reads value members eagerly, so a
  value member cannot fail closed; `definePort` rejects one.
- Optional seams are probed with `Port.isInstalled()` rather than by handing out
  the driver, so an absent seam stays distinguishable from a broken one.
- `Port.bind(scope)` returns a handle that dispatches against `scope`. Binding to
  a foreign scope requires a `// SCOPE-CROSSING:` comment naming the work that is
  not a child of the configuring scope; `sweatpants/documented-scope-crossing`
  enforces it. Treat a new one as a design question first: the count measures how
  far the scope tree has drifted from the domain model. Binding to the caller's
  own scope is exempt — it only materializes the port as an interface handle.
  See `docs/adr/004-turn-scope-and-scope-crossing.md`.
- A scope boundary locally stands in for a process boundary in production. Across
  a real distribution boundary — worker, isolate, microVM, machine — do not bind
  and do not capture handles: only serializable identity crosses, and each side
  resolves its own driver, fenced by owner and epoch where there is a writer.
- Invariants that must hold for every adapter are composed inside `install*`,
  not written into each adapter and not installed as middleware.
- A port member's return type decides what middleware may do to it, because
  `Around<T>` derives middleware from that same type. `Operation<T>` admits
  generator middleware, so latency, fault injection, deadlines, and authority
  checks can wrap the call. A plain `T` requires middleware to return `T`
  synchronously, which permits observation and substitution but permanently
  excludes anything that waits.
- Default to `Operation<T>`, even when the value is synchronous. Call sites
  cannot tell the difference, since `Api.operations` lifts a plain return into
  an operation, so the restriction is invisible at the definition site and
  surfaces only when someone needs to intercept the seam. Widening a member to
  `Operation<T>` later breaks every adapter implementing it.
- Declare a synchronous member deliberately when "this must never become
  effectful" is the invariant you want, and say so in a comment. A sync clock,
  epoch, or config read that the compiler forbids anyone from making slow or
  I/O-bound is a legitimate design choice, not an oversight. Make the intent
  explicit so a later reader does not "fix" it.
  `packages/foundation/src/port.test.ts` pins both behaviors.
- Drivers own persistence or transport mechanics only. Domain transition
  validity, retry safety, fencing, and quiescence stay in the mandatory path and
  must hold with no middleware installed.
- Only portify a boundary that crosses a process, network, or storage edge,
  needs scoped substitution in tests, or needs observation, deadlines, or
  routing without touching call sites. Pure functions and pure domain
  transitions stay plain and must run with no scope installed.
- `packages/foundation/src/styles/` holds four worked variants (api-as-port,
  derived facade, explicit facade, typed port) with tests. Read it before
  proposing a different seam shape.

### Naming: define, create, install, use

- `define*` — immutable module-level declaration, evaluated once, no mutable
  state: `definePort`, `defineDurableEffect`, `defineDurableProgramManifest`.
- `create*` — constructs a runtime instance with its own state and lifetime:
  `createMemoryExecutionStore`, `createToolSessionRegistry`, `createChannel`.
- `install*` — binds an implementation or middleware into the current scope;
  the effect ends when that scope exits: `installDriver`, `installExecutionStore`.
- `use*` — reads a scoped capability inside an Operation: `useScope`,
  `useJournalAuthority`.

If calling it twice yields two independent stateful things, it is `create*`. If
calling it twice is meaningless, it is `define*`. If its effect is bounded by a
scope, it is `install*`.

### Generator and resilience rules

- Never use a bare `yield*` as an operand of another expression. Parenthesize it
  first: `(yield* operation())`. `yield*` binds more loosely than operators, so
  `yield* operation() || fallback` does not have the `await`-like precedence a
  reader may expect and can silently skip the right-hand branch.
- Every production `catch` that intentionally makes a failure non-fatal MUST
  have a test-harness observation path. Wire the error to a scenario probe,
  failure list, metric, or teardown assertion; resilience without re-armed
  tests is silent contract drift.
- When enabling or satisfying a lint rule, prefer rule options first, then a
  targeted suppression with a reason, over rewriting correct code into a
  semantically equivalent but less readable form. If a rule fights an
  established repository idiom, configure the rule; do not launder the idiom
  into syntax that merely escapes inspection.

## Landing the Plane (Session Completion)

Before ending a coding session:

1. Summarize what changed and list touched areas.
2. Run the narrow package/type/acceptance gates while iterating.
3. For broad, risky, multi-package, generated, or user-visible changes, run `pnpm land` exactly once after narrow gates are green.
4. Run `pnpm land:live` only when provider/model integration requires it; otherwise report it as intentionally not applicable.
5. Report the landing summary path and any failing, skipped, or not-run gate accurately.

A passing `pnpm land` is required before declaring broad work complete unless the user explicitly narrows the validation scope. Do not substitute `pnpm test`, `pnpm test:e2e`, an individual Playwright file, or an existing-server run for the deterministic landing gate.

The broad live-provider Playwright suite is intentionally manual: refresh/sync Copilot auth and run `pnpm test:e2e:manual`. It is not part of `pnpm land`; see `apps/yo-chat/e2e/README.md`.

### Real providers for app validation

Never run product apps with scripted, fake, or simulated models, including for
computer-use validation. Do not add temporary provider replacements, Vite
overrides, or fallback modes to make browser checks pass. Simulator scenarios
belong in Test Rig tests. If a real provider fails, report the app validation as
blocked and investigate the actual failure; simulated results are not evidence
that the live app works.

## Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"
