# Flowmode package ownership

Names follow `flowmode-{layer}-{lang}`. The language suffix is omitted for
shared layers. Lexical sorting groups the family, then each layer and its
language implementations; it does not imply dependency order.

`flowmode-runtime` and `flowmode-backend` are workspace packages containing the
existing kernel contracts and backend adapter. Their files, tests, and consumers
have moved mechanically; interfaces and runtime behavior are unchanged.

The three compiler packages now contain the shared TypeScript frontend and both
language targets, consumed automatically through the Sweatpants Vite integration.
`flowmode-runtime-lua` and `flowmode-runtime-scheme` own the evaluators used by
yo-workflow Playground and Execution. Their package gates cover evaluator behavior
and generated assets. The scoped scheduler remains experimental.

## Ownership map

- [flowmode-backend](../../packages/flowmode-backend/README.md): shared journal
  attachment integration for language kernels.
- [flowmode-compiler](../../packages/flowmode-compiler/README.md): shared developer
  source admission, typed Scheme IR, helper-module bundling, and artifact tooling.
- [flowmode-compiler-lua](../../packages/flowmode-compiler-lua/README.md): Lua target
  lowering from the shared intermediate representation.
- [flowmode-compiler-scheme](../../packages/flowmode-compiler-scheme/README.md):
  Scheme target emission and artifact assembly.
- [flowmode-runtime](../../packages/flowmode-runtime/README.md): language-neutral
  kernel, composition, and inspection contracts.
- [flowmode-runtime-lua](../../packages/flowmode-runtime-lua/README.md): ordinary
  Lua evaluation and portable VM state.
- [flowmode-runtime-scheme](../../packages/flowmode-runtime-scheme/README.md):
  Scheme evaluation and its checkpoint-capable kernel integration.

## Promotion order

Lua owns Piccolo/Wasm, portable VM state, its evaluation port and reusable compute
replay. Scheme owns both existing evaluator paths: the Playground session API and
Execution's checkpoint kernel. These have distinct entry points and are not
silently unified. Both Playground tools use durable-tool replay for recovery;
portable Lua state between VM commands is not an authority checkpoint.

The Execution inspector separately consumes the kernel/backend and compiled
artifact path. Promoting that path must preserve its compiled developer tool,
model-authored caller, uncompiled host tool, suspended cleanup, and fresh-instance
restore behavior in both languages.

The shared runtime and backend now use the Flowmode package names. The shared
compiler protocol, portable artifact contracts and language authoring interfaces
stay in the runtime package so model-authored language stacks can implement that
protocol without depending on the TypeScript frontend. Both shared packages now
have product consumers through the promoted language runtimes and are recorded
as libraries in the workspace ledger.

The Scheme package preserves both evaluators. Unifying their language or recovery
contracts would require a separate design change.

Compiler boundaries should be checked against their actual consumers before
creating separate workspace members. A scaffold reserves a name; it does not
require a package if the implementation belongs with another layer.

## Completion criteria for each promotion

1. State the supported behavior and unsupported capabilities, with source-backed
   conformance evidence. Experimental tests alone do not establish app support.
2. Move the implementation, reproducible build inputs, and relevant tests to its
   owner. Establish explicit exports and dependency direction.
3. Migrate a real consumer and remove superseded paths in the same change. Do not
   leave aliases, re-export shims, or duplicate old/new implementations.
4. Update the workspace member ledger, language parity documentation, build
   wiring, and lockfile as applicable.
5. Pass the relevant package/type/acceptance gates and deterministic landing gate.
   Provider integration changes additionally require applicable live validation.

Scoped task scheduling and durable timers remain separate unfinished capabilities.
They are not prerequisites for promoting the existing sequential game behavior.
Generic execution/port primitives remain in `foundation`; journal, storage,
transport, and chat packages retain their existing ownership.
