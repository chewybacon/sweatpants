# Portable Lua evaluator

createLuaEvaluator binds source, input, a Wasm module loader and request/result
wire decoders. Their return types infer the Guest request and result. It exposes
lazy acquisition and optional checkpoint capabilities using v2 public contracts;
there are no legacy framework runtime imports.

Each VM command creates a fresh bounded Wasm instance. Only the supplied loader's
compiled code may be cached. The Guest retains portable VM state between turns.
Capture detaches that state; restore uses the VM's restore command, including its
source/runtime identity checks, rather than replaying the program prefix. Close
discards retained state without evaluating authored cleanup. Authored failures
throw LuaFailure with their value, distinct from transport/decoder failures.

Commands/outputs have a 4 MiB budget and compute continuations have a fuel ceiling.
Synchronous Wasm instructions are not interrupted by native cancellation. This
slice does not expose logical cancellation or claim parity with the full v1 Lua
kernel's inspection, tooling or authoring features.

## Pinned evaluator provenance

`generated/kernel.wasm` is copied unchanged from the existing v1 Piccolo artifact
at repository checkpoint 9306914993c98fdea6d3ad45d0a1b03dd65ed396. SHA-256:

    2d1062f4fffcba8a554331046953831e61a6a70ef3b19bd997b6d459cf732b81

The adjacent v1-manifest.json records its original build inputs. Source/build
scripts remain in `packages/flowmode-runtime-lua/vm` and its `scripts` directory;
the v2 package does not yet own a rebuilt compiler toolchain. Acceptance checks
the artifact hash and loads it in-process. No subprocess, native executable,
legacy JavaScript adapter or network service is used.

The public luaWasmUrl points to packaged bytes. Hosts choose their own loader;
importing this package does not compile or instantiate the VM.
