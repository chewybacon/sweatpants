# Agent Instructions

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
