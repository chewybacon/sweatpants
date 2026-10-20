# Flowmode package scaffolds

Names follow `flowmode-{layer}-{lang}`. The language suffix is omitted for
shared layers. Lexical sorting groups the family, then each layer and its
language implementations; it does not imply dependency order.

`flowmode-runtime` and `flowmode-backend` are workspace packages containing the
existing kernel contracts and backend adapter. Their files, tests, and consumers
have moved mechanically; interfaces and runtime behavior are unchanged.

The other five directories remain documentation-only scaffolds without manifests,
exports, dependencies, or placeholder APIs. Add a manifest and a member-ledger
entry when a concrete implementation moves, with its tests and consumer.

## Ownership map

- [flowmode-backend](../../packages/flowmode-backend/README.md): shared journal
  attachment integration for language kernels.
- [flowmode-compiler](../../packages/flowmode-compiler/README.md): shared developer
  source admission, Scheme intermediate representation, and artifact tooling.
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

Start with the runtime ownership boundaries used by the Playground. Scheme
currently uses `packages/scheme-runtime`; Lua reaches into
`experiments/workflow-kernel/teal-lua-checkpoint`. Both Playground language tools
use durable-tool replay for recovery. Portable Lua state between VM commands is
not an authority-owned continuation checkpoint.

The Execution inspector separately consumes the kernel/backend and compiled
artifact path. Promoting that path must preserve its compiled developer tool,
model-authored caller, uncompiled host tool, suspended cleanup, and fresh-instance
restore behavior in both languages.

The shared runtime and backend now use the Flowmode package names. Compiler and
authoring interfaces still live in the runtime package pending a separate
interface-ownership decision. The rename does not establish new capabilities or
change the packages' parked status in the member ledger.

Scheme runtime promotion still needs an explicit decision about the packaged
Playground evaluator and the experimental Execution evaluator; moving directories
does not unify them.

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
