# Agent Instructions

## Architecture Orientation

Read this before changing anything under `packages/`. It exists because the
package names do not yet match the ports they implement, and several similarly
named types are unrelated.

### The four placement axes

A request moves through four independently replaceable boxes. Most confusion
comes from collapsing box 3 and box 4, which run different code under different
constraints.

| box                   | decides                                                             | port                                                                                   | live implementations                                                    |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1. Ingress            | where HTTP lands                                                    | `createChatApplication` (`framework/src/server`)                                       | Node HTTP (`apps/yo-chat`)                                              |
| 2. Journal authority  | where truth lives; the serialization domain                         | `DurableJournalAuthorityService` (22 methods, `session-contract/src/durable-types.ts`) | `InMemoryDurableJournalAuthority`; `createRedisDurableJournalAuthority` |
| 3. Crank / activation | where the durable program generator runs; chatty with the authority | `ProgramRuntime`, `handler/durable/local-program-host.ts`                              | in-process (Node)                                                       |
| 4. Tool execution     | where tool code runs; never touches the journal                     | see the two tiers below                                                                | see below                                                               |

Box 4 has two tiers, and they are different ports:

- **Tier A — remote generator, no machine.** `ProgramDriver` (`session-contract`):
  `attach / step / shutdown / restore? / restoreContext? / manifest?`. Replays
  from the journal and runs to the next park point. No shell, disk, or ports.
  Implementations: `createLocalProgramDriver` (`session-contract/src/program-driver.ts`),
  `tool-runtime-local` (`durable-driver.ts`, `local-worker-durable-driver.ts`),
  `tool-runtime-agentcore/src/durable-driver.ts`, `a2a/src/driver.ts`.
- **Tier B — a machine with a disk.** `SandboxProvider` (`session-contract/src/sandbox-substrate.ts`):
  `create / inspect / connect / suspend? / resume? / restore? / terminate`, plus
  `SandboxCapabilities` (`shell`, `processExecution`, `localDisk`, `ports`,
  `workspacePersistence`). **This port has no implementations.** It is design
  stage; treat any first implementation as unproven, not as a second impl.

Because Tier A stops at park points, a single-invocation executor is a natural
fit for it. Long unparked work lives in box 3, not box 4.

### Names that look related but are not

- `SandboxProvider` (`session-contract`) — the Tier B runtime port. No impls.
- `SandboxProviderDefinition` (`framework/src/deployment`) — a _deployment
  descriptor_ (`image`, `lifecycle`). Produced by `lambdaMicrovm()`. Unrelated
  to the port above.
- `LambdaMicrovmWorkspaceManager` (`workspace-lambda-microvm`) — a workspace lease
  manager (`resolve / inspect / close`). Also unrelated to the port above.
- `journal-authority-redis` — despite the name, this is a **journal authority**
  implementation. It is 359 lines that load a snapshot, run the shared
  `InMemoryDurableJournalAuthority`, and CAS-write the snapshot back. All
  authority semantics live in `session-contract/src/durable-authority.ts`.

### There are two chat engines, and both are live

They serve different product surfaces. Fixing one usually means considering the
other.

- `framework/src/handler/durable/program-driver-chat-engine.ts` — the HTTP chat
  turn. Reached via `createDurableChatHandler`. This is what `apps/yo-chat` runs.
- `framework/src/lib/chat/authoring/program.ts` — authored/generated chat
  programs for A2A-served agents. Reached via `server/standard-a2a-host.ts`.

### Configuration traps that make a wrong setup look right

Each of these has silently cost real debugging time. Prefer failing loudly over
falling back.

- **`dist` vs `src`.** App tests resolve `@sweatpants/framework` to `dist/`, so
  edits to framework source have no effect until `pnpm -C packages/framework build`.
  The `development` export condition resolves to source; `packages/a2a`
  certification fixtures use `--conditions=development`.
- **Redis conformance falls back to a fake.** `journal-authority-redis`'s conformance
  suite calls `createMemoryRedisClient()` when it cannot connect, so it passes
  green against a dead port. Confirm real usage before claiming Redis coverage.
- **Worker vs in-process ToolSession registry.** Production `tool-runtime-local`
  requires a worker-backed registry (`driver.ts`). Tests that build an
  in-process registry exercise a configuration that never ships.
- **Redis persists between runs.** In-memory stores are fresh each run; Redis is
  not. Namespace conversation and key prefixes per run, as
  `apps/yo-chat/acceptance/fixtures/*-harness.ts` and the `journal-authority-redis`
  suite do.

### Durability model in one paragraph

The journal is the only authority. Everything else — hosts, runtimes,
sandboxes, transports — is replaceable compute. A host may be destroyed at any
time; work the authority accepted survives, and work it never accepted was
never promised. Unsafe effects whose attempt is detached settle as a coded
`effect_outcome_indeterminate` outcome that the authored program acts on; there
is no state where a pull parks with no exit. `apps/yo-chat/acceptance/`
demonstrates this: the harnesses model host loss by discarding a runtime while
the substrate keeps journal, stream buffers, and foreign sessions.

## Quality Gates and Definition of Done

A coding task is not done until the relevant quality gates for the touched code have passed or any remaining failures have been clearly explained to the user.

### Fast Iteration Gates

Use the narrowest deterministic tests while implementing:

1. Run package-local unit tests for packages you changed.
2. Run package-local acceptance tests for affected contracts.
3. Run type checks for touched packages/apps when the change affects TypeScript APIs or exports.
4. Run generated-artifact verification when generated files or generators are touched.

Acceptance tests are the preferred fast feedback loop for framework/package contracts. They are meant to be narrower and faster than full browser e2e while still exercising public or near-public implementation boundaries.

### Acceptance Test Policy

Acceptance tests are contractual. They should pass as written.

Framework acceptance tests under `packages/framework-acceptance` MUST use the causal generator-based `withTestScenario` authoring style by default. Read `packages/framework-acceptance/AUTHORING.md` before adding or changing those tests. Promise barriers (`withTestRig`, `expectRequest`, raw turn handles) are an advanced escape hatch and require an inline explanation of why the scenario vocabulary is insufficient. Future feature specs and plans SHOULD present framework-acceptance examples in cause-then-consequence scenario form.

Do **not** modify acceptance test expectations merely to make an implementation pass. Changing an acceptance test expectation requires explicit user approval and should normally be paired with a deliberate contract/design/spec update.

If an acceptance test consistently fails:

1. Treat it as a likely implementation regression first.
2. Investigate and summarize the failure.
3. Discuss the contract ambiguity or implementation issue with the user.
4. Do not work around the test by weakening assertions, adding skips, or changing expected behavior without approval.

### E2E Tests: Land the Plane

Use the bounded landing orchestrator after narrow implementation gates:

```bash
pnpm land       # mandatory deterministic landing gate
pnpm land:live  # provider/model-dependent validation only
pnpm land:full  # deterministic followed by live validation
```

`pnpm land` is the default definition of landed for broad, risky, multi-package, or browser-visible changes. It runs generated checks, types, lint, build, package-owned tests with bounded dependency-aware concurrency, isolated app tests, and the thin hermetic yo-chat Playwright boundary—including deterministic threaded AG-UI reconstruction. Third-party MCP Inspector UI checks are opt-in (`pnpm -C apps/yo-mcp test:inspector`); MCP protocol/backchannel behavior is part of package acceptance.

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
export const ExecutionStorePort = definePort<ExecutionStore>("journal-authority-execution-store", {
    *loadExecution(_executionId): Operation<VersionedExecution | null> {
        return unavailable();
    },
});

yield * ExecutionStorePort.installDriver(createMemoryExecutionStore());
yield * ExecutionStorePort.api.operations.loadExecution(id);
```

Rules:

- Drivers install at `at: "min"` (handled by `installDriver`) so policy and
  observation middleware, which default to `at: "max"`, always surround them.
  Installation order between a driver and middleware does not matter.
- Installation is bound to the current Effection scope: inherited by children,
  shadowable by a child, isolated between concurrent siblings, and discarded when
  the scope exits. See `packages/foundation/src/port.test.ts`.
- Every port member MUST be declared as returning `Operation<T>`, even when the
  underlying value is synchronous. `Around<T>` derives middleware from the
  member's own return type, so a member typed `foo(): T` forces middleware to
  return `T` synchronously: it cannot be a generator, and therefore no latency,
  fault-injection, deadline, or authority middleware can ever wrap it. Callers
  cannot detect the difference, because `Api.operations` lifts a plain return
  into an operation, so the downgrade is silent at the definition site and only
  bites whoever later needs to intercept the seam. Converting a member to
  `Operation<T>` afterwards is a breaking change to every adapter.
  `packages/foundation/src/port.test.ts` pins both halves of this.
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

## Landing the Plane (Session Completion)

Before ending a coding session:

1. Summarize what changed and list touched areas.
2. Run the narrow package/type/acceptance gates while iterating.
3. For broad, risky, multi-package, generated, or user-visible changes, run `pnpm land` exactly once after narrow gates are green.
4. Run `pnpm land:live` only when provider/model integration requires it; otherwise report it as intentionally not applicable.
5. Report the landing summary path and any failing, skipped, or not-run gate accurately.

A passing `pnpm land` is required before declaring broad work complete unless the user explicitly narrows the validation scope. Do not substitute `pnpm test`, `pnpm test:e2e`, an individual Playwright file, or an existing-server run for the deterministic landing gate.

The broad live-provider Playwright suite is intentionally manual: refresh/sync Copilot auth and run `pnpm test:e2e:manual`. It is not part of `pnpm land`; see `apps/yo-chat/e2e/README.md`.

## Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"
