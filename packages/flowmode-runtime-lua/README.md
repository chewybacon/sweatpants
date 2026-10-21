# Flowmode Lua runtime

`@sweatpants/flowmode-runtime-lua` owns ordinary Lua evaluation through the pinned
Piccolo VM, portable VM state, workflow kernels, and durable-tool compute replay.
It is consumed by both yo-workflow Playground and Execution.

- The root export declares `LuaEvaluationPort` and its typed commands.
- `/wasm` supplies `createWasmLuaInvoker(loadModule)` for Workers and other Wasm
  hosts. Each command uses a fresh bounded instance; only code is cached.
- `/node` loads the packaged Wasm and exports `invokeWasm`.
- `/kernel` implements the shared `WorkflowKernel` contract. `/program` assembles
  it through `flowmode-backend` and the existing `createWorkflowProgramDriver`.
- `/authoring` validates and links ordinary Lua callers. TypeScript compilation
  remains in `flowmode-compiler-lua`.
- `/replay` runs recorded compute slices for a durable tool. The consumer supplies
  capability validation/dispatch and computation approval. App prompts and UI
  events are not runtime policy.

Playground records compressed portable VM state through durable-tool replay. It
does not persist a Lua continuation as an authority checkpoint. Execution uses
kernel capture/restore through the shared backend; journal provenance remains
owned by the authority.

The VM supports sequential Lua control flow, closures, shared upvalues, bounded
JSON exchanges, cancellation and cleanup that may suspend. Its standard library
is deliberately limited to `assert`, `type`, `pcall`, and `error`, plus workflow
intrinsics. Lexical environment and unwind inspection are unavailable; consumers
may display raw VM frames and checkpoint state. The scoped-handoffs scheduler and
durable timers are not supported by this runtime.

## Build and verification

`pnpm wasm:build` downloads Piccolo at a pinned revision, verifies its archive
hash, applies the tracked checkpoint patch, and builds with Rust 1.88.0 in Docker.
Cargo's lockfile and Wasm configuration are part of the verified inputs. The
64 MiB memory ceiling is imposed by the linker. Commands and outputs are limited
to 4 MiB. Generated Wasm and its source manifest live in `generated/`; caches live
in the repository's ignored `.artifacts/flowmode-runtime-lua/`.

`pnpm wasm:check` verifies packaged bytes and build inputs without Docker.
`pnpm wasm:verify` rebuilds and compares bytes. `pnpm build`, `pnpm check`, and
`pnpm test` are package gates. Tests cover fresh-instance restore, shared cells,
fuel slicing, tail-call exchange, rejection and cancellation. App durability and
Execution acceptance suites retain the real journal integration coverage.
