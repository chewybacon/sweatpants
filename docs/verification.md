# Workspace tasks and verification

The root exposes seven task namespaces. `lint`, `format`, `build`, `check`, `test`
and `dev` dispatch the same command to every workspace that defines it. Workspace
membership is declared in `pnpm-workspace.yaml`: `packages/*`, `apps/*`,
`acceptance`, and `scripts`. `land` is root-only and controls its stages explicitly.

```bash
pnpm lint
pnpm format                          # writes formatting
pnpm format:check
pnpm build
pnpm check                           # source + strict test types
pnpm test                            # all workspace suites, including tooling
pnpm --filter yo-chat dev             # one app
pnpm --filter @sweatpants/tool-runtime-local check
pnpm --filter @sweatpants/acceptance test
pnpm --filter @sweatpants/acceptance test __tests__/application-composition/react-plugin.acceptance.test.tsx
```

Use native pnpm filters before the task. A filtered invocation runs the member's
own command. Add `...` to a selector when prerequisites are needed, for example
`pnpm --filter 'yo-chat^...' build`. Unfiltered finite tasks run in dependency
order. `check` permits four workspaces at once; other finite tasks use workspace
concurrency 1. `dev` runs in parallel because watch/server
tasks do not finish; unfiltered `pnpm dev` starts every available dev task.

Every workspace owns its lint and formatting scope. The `scripts` workspace,
`@sweatpants/repository`, owns repository tooling tests and files outside the
other members. Its lint/format scans exclude `packages`, `apps`, and `acceptance`,
so no directory is scanned twice. All commands retain the shared root configs.
Production and strict test types run through each package's `check` task;
acceptance checks its Node/React and Cloudflare configs exactly once each.

## TypeScript checks

Every workspace `tsc` command uses TypeScript 7.0.2's native compiler from the
shared catalog. Node ambient types are explicit in the shared configuration.
Production project builds already retain build information; test, application,
acceptance and standalone check configs also retain incremental state. Source
changes invalidate that state. A successful cached run still checks every
configured project; no files, assertions or strict compiler checks are removed.
Build-info files are ignored by Git and removed by `build:clean`.

Runtime compiler API consumers are separate from the workspace checker.
Flowmode and repository source analysis use the `typescript-api` alias for the
JavaScript API in TypeScript 6.0.3. `.pnpmfile.cjs` gives named third-party API
consumers their newest compatible JavaScript release below 7; `tsup` stays below
6 because its declaration worker injects the deprecated `baseUrl` option.
Tools that support the native compiler keep TypeScript 7. These private tooling
dependencies do not change the compiler selected by workspace `check` commands.

## Build subtasks

```bash
pnpm build:clean                      # clean generated outputs per workspace
pnpm --filter @sweatpants/agent-host build:clean
pnpm build:check                      # export and product-surface validators
pnpm build:verify                     # clean -> build -> validate
```

`build` runs workspace builds. Artifact validators are explicit `build:check`
tasks, owned by repository tooling. `build:clean` removes `dist`, `.tsup` and
TypeScript build-info files inside the selected workspace while preserving
source and `node_modules`. Package checks may emit declaration/build-info files;
this does not replace a package's JavaScript build.

## Selected verification

`pnpm check:change` checks affected projects and transitive consumers. It supports
all workspace members, including public acceptance and repository tooling.

```bash
pnpm check:change --plan
pnpm check:change --base origin/main
pnpm check:change --package @sweatpants/flowmode-runtime --plan
pnpm check:change --test packages/flowmode-runtime/src/__tests__/composition.test.ts
```

The planner refreshes build prerequisites, then invokes workspace checks, lint,
format checks and tests. Workspace `check` owns test types; the planner does not
run a second test-type pass. Lua/Scheme Node tests retain their Node runners;
public acceptance retains its source-aware command for child hosts/workers.
Workflow-dependent selections also compile the local standalone fixtures.
Shared/unmapped inputs fall back to root landing. Selection does not prove every
runtime import; generated assets, workers, WASM and storage boundaries still need
relevant checks. `--plan` prints commands without executing them.

## Final verification

Acceptance stops after the first failure and performs no retries. Individual test
timeouts remain 30 seconds (unless a test explicitly overrides them), and fixture
subprocess deadlines remain in force. The acceptance stage has a 12-minute outer
cap, allowing headroom for the expanded suite (recently about 581 seconds). A
synchronous event-loop lock can prevent a test timer from firing; the separate
landing process deadline remains the backstop. Landing stops after a failed stage.

Run `pnpm land` once focused checks pass. It owns exactly four sequential stages:

1. `pnpm lint`
2. `pnpm format:check`
3. `pnpm check`
4. `pnpm --filter @sweatpants/acceptance test`

Public acceptance uses development source exports in Vitest and Node child
processes. It needs no prior workspace build, provider credentials or external database
service. It uses one worker, real local runtime boundaries, temporary SQLite
databases, a test-owned local Postgres cluster and local workerd D1. Postgres
server binaries must be installed; `PG_BIN` can select their directory. Landing stops on the first failure, persists stage logs and a
summary under `.artifacts/landing`, and rejects lost collection or skipped tests.

`pnpm test` remains the broader collection of package, app, tooling and acceptance
suites. Specialized storage suites may require disposable Postgres or Redis.
Browser checks are app-owned, for example `pnpm --filter yo-chat test:e2e` or
`pnpm --filter yo-chat test:e2e:manual` for real providers. Platform storage/process
lanes remain under `pnpm --filter @sweatpants/platform-acceptance test:memory`,
`test:sqlite`, and `test:process`. These targeted suites are not landing stages.

`pnpm land:live` adds provider/model validation when relevant; `pnpm land:full`
runs deterministic landing followed by live validation. Follow `AGENTS.md` for
failure/timeout rules. No workspace member defines its own `land` command.
