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
and authority changes also run execution-recovery probes. Final landing runs lint, formatting, type checking and public acceptance.
Run clean-build/export checks and package/app suites when the changed code needs them.

Scheme/app-service checks also build the standalone workflow fixtures used by
the Node tests. `yo-workflow execution:compile` uses the lockfile-pinned local
tsdown dependency; it does not download a separate compiler through `pnpm dlx`.
These fixtures are needed by the targeted workflow suites, not public acceptance.

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

The memory lane excludes the SQLite-only timeline and process suites. The SQLite
lane runs the two timeline cases; the process lane runs two fresh-process suites.
Tool-loop contracts live in `pnpm test:acceptance`. Platform `test` composes all
three lanes and remains available for targeted verification outside landing.

For a single backend-sensitive scenario during editing, invoke Vitest directly
instead of forwarding a file argument to a script that chains suites:

```bash
pnpm -C packages/platform-acceptance exec vitest run src/__tests__/windowed-runtime.acceptance.test.ts --maxWorkers=1
PLATFORM_ACCEPTANCE_STORAGE=sqlite pnpm -C packages/platform-acceptance exec vitest run src/__tests__/windowed-runtime.acceptance.test.ts --maxWorkers=1
```

## Final verification

Run `pnpm land` once narrow checks are green. It executes exactly these four stages:

1. `pnpm lint`
2. `pnpm format:check`
3. `pnpm check:landing` — production, package-test, acceptance (including Cloudflare fixtures), and app types.
4. `pnpm test:acceptance` — all public authoring, recovery, runtime and host-crash cases.

Acceptance resolves development source exports in Vitest and Node child processes.
It needs no prior build, provider credentials, Postgres or Redis services. It uses
one Vitest worker, real local runtime boundaries and temporary SQLite databases.
Landing stops on the first failure, persists per-stage logs and a summary under
`.artifacts/landing/`, and rejects lost collection or skipped acceptance cases.

Clean builds, export/generated checks, tooling tests and package/app suites remain
available separately. Run the relevant checks for changes to those boundaries.
Storage-specific suites can require disposable Postgres or Redis services; those
services are no longer prerequisites for `pnpm land`.

Use `pnpm land:live` when provider/model integration changes or live confidence is
requested. `pnpm land:full` runs both gates. A selected verification result is not
a passing landing result. Follow the failure and timeout rules in `AGENTS.md`.
