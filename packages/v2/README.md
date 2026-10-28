# Framework reconstruction

This directory groups the new packages while existing `@sweatpants/*` packages
remain available as references. `v2` is not part of a public package name.
Packages start private. Portable computation and composition, both native adapters,
execution, replay/checkpoint recovery, hosting, memory journals and the Lua evaluator
are implemented with acceptance journeys; other packages remain scaffolds.

## Package conventions

- `src/contracts.ts`: public capability interfaces, options, results and type aliases.
- `src/types.ts`: internal implementation types shared across local modules.
- `src/index.ts`: explicit public exports and intentional re-exports; no wildcard
  exports, initialization side effects or implementation logic.
- Implementations live in focused sibling files. File-local helper types may stay
  with their implementation.
- Internal modules import siblings directly, not their own index. Other packages
  use declared package entry points, never internal source paths.
- Public exports carry JSDoc on their defining declaration (including public
  contract methods). Describe observable behavior, ownership, cancellation and
  material failure cases; include an example when it clarifies assembly. Re-export
  from index.ts without duplicating the documentation. Keep README prose for
  package orientation and acceptance evidence. Apply this as APIs are added or changed.
- Public signatures must not leak internal types. Public contracts must not import
  local implementations.
- Higher-level entry points may re-export lower-level public contracts and portable
  helpers. Concrete adapters remain explicit choices; a facade must not load every
  runtime, database or evaluator.

Unsuffixed capability packages own portable contracts and helpers. Implementation
suffixes identify native runtimes, platforms, languages and storage backends.
Codemode owns code authoring/orchestration. Execution owns generic Guest and
checkpoint contracts; codemode-runtime remains reserved for language-specific
evaluator capabilities, and codemode-runtime-lua supplies the Lua evaluator.

`@standard-durability/*` owns portable authoring and scoped composition.
`@sweatpan.ts/*` owns framework capabilities and adapters.
`@sweatpan.tsx/*` owns React integrations.

## Wiring

The root pnpm workspace discovers `packages/v2/*`. Every package has build, check,
lint and formatting-check scripts; root recursive commands include them.
Development exports resolve source; production exports resolve built ESM and
TypeScript declarations. Only the root entry point is exported initially.
The shared TypeScript configuration reuses repository build infrastructure.

Run `pnpm v2:build` to build the scaffolds.
No runtime dependency edges are declared until their implementations are ported.
Any dependency on an existing `@sweatpants/*` implementation must be deliberate and
documented. Browser, server and build-time dependencies must remain separate.
Storage adapters implement specific capabilities; backend names do not promise
interchangeable persistence guarantees.

These placeholders record intended ownership, not completed capabilities.
Port acceptance evidence alongside behavior, preserving both iterator replay and
checkpointable codemode recovery. Existing deployment implementations remain
reference material in Git history.

## Root commands

- `pnpm v2:land`: v2 lint, formatting, builds, type checks and acceptance tests.
- `pnpm land`: alias for `v2:land` during reconstruction.
- `pnpm v2:lint`: lint only packages/v2.
- `pnpm v2:format` / `pnpm v2:format:check`: format or check packages/v2.
- `pnpm v2:check`: type-check v2 packages.
- `pnpm v2:build`: build v2 packages.
- `pnpm v2:test` / `pnpm v2:test:watch`: run or watch v2 acceptance journeys.

The focused gate does not run legacy package checks or live deployment tests.

## Acceptance testing

`@sweatpan.ts/acceptance` is the primary v2 test suite. It consumes public APIs and
uses protocol-simulated, in-process test rigs from `@sweatpan.ts/testing`.
There are no v2 unit tests. See [AGENTS.md](./AGENTS.md) and the
[acceptance journey conventions](./acceptance/__tests__/README.md).

The runtime acceptance journeys run identical portable workflows under Effect and
Effection using an in-process scripted protocol peer. Native imports are confined
to stack assembly; compile-time fixtures verify Computation mappings, retained
native requirements and rejection of cross-runtime work. These tests cover local
execution and cleanup, not durable persistence or real process-loss recovery.

Root `pnpm land` runs this suite under its own coverage identity
(`test:acceptance:v2`); the legacy coverage baseline remains separate.

## Package inventory

| Directory                       | Package                                 |
| ------------------------------- | --------------------------------------- |
| `core`                          | `@sweatpan.ts/core`                     |
| `runtime`                       | `@sweatpan.ts/runtime`                  |
| `runtime-effection`             | `@sweatpan.ts/runtime-effection`        |
| `runtime-effect`                | `@sweatpan.ts/runtime-effect`           |
| `execution`                     | `@sweatpan.ts/execution`                |
| `execution-in-process`          | `@sweatpan.ts/execution-in-process`     |
| `execution-worker`              | `@sweatpan.ts/execution-worker`         |
| `execution-cloudflare`          | `@sweatpan.ts/execution-cloudflare`     |
| `execution-agentcore`           | `@sweatpan.ts/execution-agentcore`      |
| `durable`                       | `@sweatpan.ts/durable`                  |
| `tools`                         | `@sweatpan.ts/tools`                    |
| `agent`                         | `@sweatpan.ts/agent`                    |
| `chat`                          | `@sweatpan.ts/chat`                     |
| `chat-client`                   | `@sweatpan.ts/chat-client`              |
| `codemode`                      | `@sweatpan.ts/codemode`                 |
| `codemode-runtime`              | `@sweatpan.ts/codemode-runtime`         |
| `codemode-runtime-lua`          | `@sweatpan.ts/codemode-runtime-lua`     |
| `codemode-runtime-scheme`       | `@sweatpan.ts/codemode-runtime-scheme`  |
| `codemode-compiler`             | `@sweatpan.ts/codemode-compiler`        |
| `codemode-compiler-lua`         | `@sweatpan.ts/codemode-compiler-lua`    |
| `codemode-compiler-scheme`      | `@sweatpan.ts/codemode-compiler-scheme` |
| `hosting`                       | `@sweatpan.ts/hosting`                  |
| `hosting-cloudflare`            | `@sweatpan.ts/hosting-cloudflare`       |
| `deployment`                    | `@sweatpan.ts/deployment`               |
| `deployment-cloudflare`         | `@sweatpan.ts/deployment-cloudflare`    |
| `deployment-agentcore`          | `@sweatpan.ts/deployment-agentcore`     |
| `deployment-lambda`             | `@sweatpan.ts/deployment-lambda`        |
| `protocols`                     | `@sweatpan.ts/protocols`                |
| `protocols-mcp`                 | `@sweatpan.ts/protocols-mcp`            |
| `protocols-http`                | `@sweatpan.ts/protocols-http`           |
| `protocols-ag-ui`               | `@sweatpan.ts/protocols-ag-ui`          |
| `storage`                       | `@sweatpan.ts/storage`                  |
| `storage-memory`                | `@sweatpan.ts/storage-memory`           |
| `storage-sqlite`                | `@sweatpan.ts/storage-sqlite`           |
| `storage-postgres`              | `@sweatpan.ts/storage-postgres`         |
| `storage-cloudflare`            | `@sweatpan.ts/storage-cloudflare`       |
| `storage-redis`                 | `@sweatpan.ts/storage-redis`            |
| `history`                       | `@sweatpan.ts/history`                  |
| `providers`                     | `@sweatpan.ts/providers`                |
| `providers-pi-ai`               | `@sweatpan.ts/providers-pi-ai`          |
| `workspace`                     | `@sweatpan.ts/workspace`                |
| `workspace-local`               | `@sweatpan.ts/workspace-local`          |
| `workspace-lambda`              | `@sweatpan.ts/workspace-lambda`         |
| `rendering`                     | `@sweatpan.ts/rendering`                |
| `testing`                       | `@sweatpan.ts/testing`                  |
| `vite`                          | `@sweatpan.ts/vite`                     |
| `standard-durability`           | `@standard-durability/core`             |
| `standard-durability-effection` | `@standard-durability/effection`        |
| `standard-durability-effect`    | `@standard-durability/effect`           |
| `react-chat`                    | `@sweatpan.tsx/chat`                    |
| `react-rendering`               | `@sweatpan.tsx/rendering`               |
| `acceptance`                    | `@sweatpan.ts/acceptance`               |
