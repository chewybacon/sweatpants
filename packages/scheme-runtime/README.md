# Scheme runtime

Hoot Scheme evaluation for Node and Cloudflare Workers. `yo-tisyn` consumes
this package and owns its authoring instructions, tool bindings, and journal.
This package owns the restricted evaluator, JSON bridge, runtime limits,
platform loaders, and generated WASM assets.

## Build

From the workspace root:

```sh
pnpm --filter @sweatpants/scheme-runtime wasm:build
pnpm --filter @sweatpants/scheme-runtime wasm:check
pnpm --filter @sweatpants/scheme-runtime wasm:verify
pnpm --filter @sweatpants/scheme-runtime build
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

## Node compatibility follow-up

- [ ] Investigate and retest Node 22 compatibility for the experimental
      [explicit-state composition evaluator](../../experiments/workflow-kernel/hoot-composition/README.md).
      Its expanded Wasm binary crashes Node 22.21.1 on arm64 in V8 Liftoff's
      `PrepareTailCall` with an `is_int9(x)` assertion. Disabling Liftoff is a
      diagnostic workaround. This finding concerns the experimental binary; it
      does not establish a failure in this package's production evaluator.
      Before claiming Node 22 support for the experiment, run its fresh-instance
      composition, authority, scopes, and finally suites with Liftoff enabled on
      a current Node 22 release.

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
