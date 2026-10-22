# Flowmode Scheme runtime

`@sweatpants/flowmode-runtime-scheme` owns the two Scheme evaluators currently used
by yo-workflow. They share the pinned Hoot toolchain and reflection machinery,
but have different language and recovery contracts.

The root, `/node`, `/worker`, `/language`, and `/manifest` exports preserve the
Playground evaluator previously packaged as `scheme-runtime`. Its scoped
`SchemeEvaluationPort` owns bounded evaluator sessions. Durable-tool replay
reconstructs a session after host loss. See [Playground](docs/playground.md).

The `/execution/*` exports contain the portable evaluator, authoring/linking,
inspection and kernel assembly used by Execution. They preserve lexical frames,
shared cells and suspended cleanup across capture and fresh-instance restore.
`/execution/program` composes the shared `flowmode-backend` with the existing
`createWorkflowProgramDriver`; it does not introduce another attachment protocol.
Assembly uses the shared `createKernelProgram` factory. Program options accept
`runtimeOptions` for runtime, kernel and execution middleware; `createKernel()`
returns an Effection operation and uses that same composition on direct acquisition.
`/execution/machine-api` is portable, while `/execution/machine` and
`/execution/driver` are Node loaders. Worker consumers load the packaged static
Wasm and reflection bridge through `/execution/kernel.wasm` and
`/execution/reflect-worker.mjs`.

Neither evaluator replaces the other. A common language API would hide real
semantic differences; convergence is a separate design change. TypeScript
compilation remains in `flowmode-compiler-scheme`. The scoped scheduler and durable
timers are not supported here.

## Build and verification

`pnpm wasm:build` builds Playground's assets with the pinned Docker toolchain.
`pnpm execution:build` builds the checkpoint evaluator with that same toolchain
and metering pass. Both publish into this package's `generated/` directory.
`pnpm wasm:check` checks packaged inputs and assets; the Node execution loader
also verifies its evaluator, build script, toolchain, metering and Wasm hashes.

`pnpm test` runs Playground tests and Execution conformance, including native
Scheme composition, cleanup, checkpoint validation and inspection. `pnpm check`
and `pnpm build` cover the exported host code. yo-workflow retains the app-facing
approval, cleanup, single receipt, natural-language authoring and reload tests.

Compiled elicitation follows the existing Sweatpants tool contract: a request
contains `message`, and a reply carries `action` and accepted `content`. The
compiler currently admits the message-only request subset. Arbitrary JSON travels
through program input, captured values, effect payloads and response content; it
is not a parallel elicitation request format.
