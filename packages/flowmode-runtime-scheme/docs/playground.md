# Scheme runtime

Hoot Scheme evaluation for Node and Cloudflare Workers. `yo-workflow` consumes
this package and owns its authoring instructions, tool bindings, and journal.
This package owns the restricted evaluator, JSON bridge, runtime limits,
platform loaders, and generated WASM assets.

## Build

From the workspace root:

```sh
pnpm --filter @sweatpants/flowmode-runtime-scheme wasm:build
pnpm --filter @sweatpants/flowmode-runtime-scheme wasm:check
pnpm --filter @sweatpants/flowmode-runtime-scheme wasm:verify
pnpm --filter @sweatpants/flowmode-runtime-scheme build
```

`wasm:build` requires Docker, Python 3, and Node with Wasm GC support. It builds
an image using the base digest, Debian snapshot, and exact compiler versions in
`toolchain.json`. The compiler platform is pinned to linux/arm64; other hosts
need Docker emulation. Compilation runs without network access.

The pipeline is Hoot `compile-file` → structured-module metering →
`assemble-wasm` → reflection adapters → native module validation → publication.
Compilation and validation happen in a temporary directory. The manifest is
published last, so interrupted publication is detected by `wasm:check`.

`wasm:check` checks source and artifact hashes without Docker. Normal package
builds use the checked-in assets. `wasm:verify` rebuilds and compares the result
to the manifest without replacing assets; use it when changing the toolchain.
Compiler upgrades require changing the explicit pins, rebuilding, and running
the evaluator and app durability/Worker acceptance suites.

Node support follows the repository requirement: Node 24.22 or later.

## Boundaries

Hoot's compiler and assembler provide the structured module interface. The
metering pass is ours, **not an upstream fuel feature**. It charges function
entries and loops in the evaluator module. It does not meter host imports,
native allocations, or the separate reflection modules, and is not a memory or
wall-clock quota. Changes to Hoot's module representation need review.

Programs receive an explicit Scheme environment. Effects leave through the
pull-based evaluator port; replay and effect persistence belong to the host.
The runtime does not own a journal or model provider.

Upstream runtime licenses and notices are in `licenses/`; they apply to the
bundled Hoot assets independently of the package's TypeScript wrapper license.

## Authoring reference and checks

`@sweatpants/flowmode-runtime-scheme/language` exports build-generated JSON: the explicit
Scheme imports, injected procedure signatures, macro patterns, and input binding.
`scripts/language.scm` reads the evaluator source as Scheme data during the pinned
build; it does not execute the evaluator or parse authored programs. The artifact
is published and hash-checked with the Wasm. Yo-workflow renders its authoring
reference from this metadata, runtime limits, executable examples, and installed
capability schemas. Semantic guidance is prose; names and signatures are extracted.

`checkSchemeProgram({ source, input })` is an Effection operation using the installed
evaluation port. It checks JSON serialization and Hoot syntax, macro expansion,
bindings, and statically known lexical call arities without executing effects. Its result explicitly lists unchecked
runtime shapes, effect requests, and termination. This is not a static type checker.
`schemeDiagnostic` normalizes error messages while retaining the original detail.
Only reader input locations are presented as authored locations; runtime errors do
not yet have source maps or authored call stacks. Field errors identify the key and
value kind without exposing the value's contents.
