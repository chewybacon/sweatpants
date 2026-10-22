# Iteration and final verification

Run commands from the repository root. `pnpm verify:change` prepares fresh build
artifacts, then checks affected workspace projects and their transitive consumers.
It includes package checks, strict test types, type-aware lint, formatting, and
package-owned suites. It does not replace final landing.

```bash
# Inspect selection without executing anything.
pnpm verify:change --plan

# Check staged, unstaged, and untracked inputs against HEAD.
pnpm verify:change

# Include committed branch changes as well.
pnpm verify:change --base origin/main

# Select an explicit root and its consumers, ignoring other local edits.
pnpm verify:change --package @sweatpants/flowmode-runtime --plan

# Build prerequisites and check one test file plus its owning project's types/lint.
pnpm verify:change --test packages/flowmode-runtime/src/__tests__/composition.test.ts
```

Use a package name or repository-relative package directory with `--package`;
repeat the flag to select multiple roots. `--test` selects one existing test,
including Lua/Scheme Node test files, and intentionally omits downstream suites.
All selectors print the commands they will execute. Shared scripts, root config,
lockfiles, deleted/unmapped projects, and unknown runtime inputs trigger the
complete `pnpm land` gate. New files are included in automatic selection.

The dependency graph is not proof of every runtime import. Generated assets,
workers, WASM, service setup, and cross-boundary contracts still require their
own checks. A package selection includes downstream consumers; relevant runtime
and authority changes also run execution-recovery probes. Final landing retains
the clean build, export checks, and complete deterministic suite.

Scheme/app-service checks also build the standalone workflow fixtures used by
the Node tests. `yo-workflow execution:compile` uses the lockfile-pinned local
tsdown dependency; it does not download a separate compiler through `pnpm dlx`.
Landing prepares these fixtures immediately after the clean workspace build.

## The editing loop

After preparing dependencies once, keep a selected Vitest file in watch mode:

```bash
pnpm -C packages/flowmode-runtime exec vitest src/__tests__/composition.test.ts
pnpm check:tests packages/flowmode-runtime
```

`pnpm check:tests` without arguments still checks every configured package. The
selected form uses the same strict config and accepts multiple package directories.

Watch mode avoids repeated module startup. When a test or child worker resolves
`dist`, rebuild the changed dependency before trusting its result. Re-run
`verify:change` after implementation edits that affect built artifacts; its build
is scoped but deliberately not assumed to be cached. The command fails at the
first unsuccessful check and does not update collection baselines.

## Framework acceptance lanes

```bash
pnpm -C packages/platform-acceptance test:memory
pnpm -C packages/platform-acceptance test:sqlite
pnpm -C packages/platform-acceptance test:process
```

The memory lane excludes two SQLite-only process suites. The SQLite lane reruns
backend-sensitive scenarios with file-backed storage. The process lane runs those
two SQLite-only suites once. Tool-loop contracts now live in the unified
`pnpm test:acceptance` package. The remaining platform `test` composes three lanes;
landing tracks a separate
collection baseline for each. Memory gets four workers under landing, while
SQLite and process probes get one. All assertions and test deadlines are retained.

For a single backend-sensitive scenario during editing, invoke Vitest directly
instead of forwarding a file argument to a script that chains suites:

```bash
pnpm -C packages/platform-acceptance exec vitest run src/__tests__/windowed-runtime.acceptance.test.ts --maxWorkers=1
PLATFORM_ACCEPTANCE_STORAGE=sqlite pnpm -C packages/platform-acceptance exec vitest run src/__tests__/windowed-runtime.acceptance.test.ts --maxWorkers=1
```

## Final verification

Storage and app tests require a disposable Postgres server. The default harness
starts Docker on port 55432 and recreates `sweatpants_test`. Check that prerequisite
before a long run:

```bash
pnpm -C packages/storage-postgres exec node scripts/ensure-test-postgres.mjs
```

To use an existing disposable server on another port, set both URLs for the full
run: `SWEATPANTS_TEST_DATABASE_URL` to its `/postgres` admin database, and
`SWEATPANTS_DATABASE_URL` to `/sweatpants_test`. This skips Docker setup and routes
the later app tests to the same test database.

The package suite also exercises a real Redis token-buffer store. Provide a
disposable Redis server through `REDIS_URL` (default `redis://localhost:6379`)
and verify that it responds before landing. Missing Redis can produce green
package exits with skipped tests; landing rejects skips above its recorded
allowance. Use the actual service rather than raising that allowance.

Run `pnpm land` once narrow checks are green. Its early format/hygiene/evidence
checks fail cheaply, then it performs the complete deterministic gate. Package
test concurrency remains configurable with `LAND_PACKAGE_TEST_CONCURRENCY` (1–8,
default 1). Each test runner has an independent bounded worker budget; do not
raise workspace concurrency and runner concurrency simultaneously without evidence.

Use `pnpm land:live` when provider/model integration changes or live confidence is
requested. `pnpm land:full` runs both gates. A selected verification result is not
a passing landing result. Follow the failure and timeout rules in `AGENTS.md`.
