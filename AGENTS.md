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

Do **not** modify acceptance test expectations merely to make an implementation pass. Changing an acceptance test expectation requires explicit user approval and should normally be paired with a deliberate contract/design/spec update.

If an acceptance test consistently fails:

1. Treat it as a likely implementation regression first.
2. Investigate and summarize the failure.
3. Discuss the contract ambiguity or implementation issue with the user.
4. Do not work around the test by weakening assertions, adding skips, or changing expected behavior without approval.

### E2E Tests: Land the Plane

E2E tests are the final confidence gate when applicable. Use them to land the plane after the narrower tests are passing.

- For app/browser flows, run the relevant Playwright e2e tests before calling the work done.
- For broad/risky changes, run the full e2e suite.
- Prefer deterministic acceptance tests during implementation, then e2e as the final integration check.
- If testing against an already-running dev server, set `PLAYWRIGHT_REUSE_EXISTING_SERVER=1`; otherwise Playwright may launch a separate server instance.

### Generated Files

Generated files must be produced by their generator, not hand-edited.

For yo-chat tool generation:

```bash
pnpm -C apps/yo-chat generate:tools
pnpm verify:generated
```

If generated output is stale, regenerate it and review the generated diff. Do not patch generated artifacts manually as the primary fix.

## Landing the Plane (Session Completion)

Before ending a coding session:

1. Summarize what changed and list touched areas.
2. Run the relevant fast iteration gates for touched code.
3. Run applicable acceptance tests and ensure they pass.
4. Run applicable e2e tests as the final landing step.
5. Report any skipped, failing, or not-run gates explicitly with the reason.

For changes affecting multiple apps/packages or user-visible browser flows, the expected final gate is:

```bash
pnpm test:e2e
```

unless the user explicitly scopes the validation more narrowly.

## Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"
