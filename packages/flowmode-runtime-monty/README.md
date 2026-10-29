# Monty workflow runtime

Actual Rust Wasm execution through the existing Flowmode kernel and journal-authority backend.
The Python author writes `async def workflow()` using supplied `operation(label)`, `Scope`, `join(handle)`, `gather(first, second)` and `Queue(capacity)` contracts.
See `guest/demo.py` and acceptance coverage in `acceptance/__tests__/monty/`.
The library is thin bindings and scope cleanup; Rust owns task scheduling, queues and cancellation.

`createMontyKernel(loadModule)` provides start/restore/capture/inspect/dispose through the shared kernel API.
`createMontyProgram({source, contract, bindOperation}, loadModule)` uses the shared program backend and driver.
The Node entry only loads the same Wasm bytes; it never starts a native process.
The worker entry statically imports four vendored core modules for workerd.
Runtime code has no sibling checkout paths. The generated wrapper contains a dormant `node:fs/promises` fallback; the worker’s explicit module loader bypasses it. The Node entry intentionally reads package-local Wasm. The worker execution path exposes no filesystem or network capability or guest clock service.
The minimal WASI imports supply host infrastructure clocks and entropy; unexpected guest OS boundaries are rejected.

Each external waiting boundary contains all outstanding operations, with VM-issued IDs and labels.
The Execution lab maps that frontier to **one journal elicitation** whose response selects an operation ID.
This is a batch interaction contract, not independent journal pulls for each Python task.
Concurrent operations remain outstanding inside Monty and may be answered in any order.
The journal owns reply capabilities, revision/first-settlement authority, cancellation and checkpoint persistence.
No external service is called by this demo; there is no background dispatcher or alarm API.

Only snapshots from trusted compatible journal storage may be restored.
Snapshot envelopes pin program source, supplied library, runtime identity and artifact digest.
`generated/executable-identity.mjs` supplies the SHA-256 of the full manifest (recursively sorted JSON keys, including all five executable hashes, source commit and association hash). Kernel identity combines this digest with the guest library and adapter version. Any executable repin invalidates prior checkpoints before Wasm instantiation; unchanged identity restores normally. Old local UI runs from the earlier identity are intentionally incompatible; start new runs.
Opaque producer bytes are retained unchanged until the next VM turn; Monty reserialization is not canonical.
Restore loads a fresh Wasm instance and observes its actual waiting boundary without decoding the heap.
Frames, local variables, step counts and cleanup stacks are explicitly unavailable.
Disposal resets the worker and drops the JS reference; it is not logical cancellation.
Repeated logical cancellation preserves protected cleanup and terminal cancellation is sticky.

## Artifacts and local rebuild

`generated/manifest.json` pins source commit `b3a21cc717fd8c02fcfd123e6438e949889330f1`, the accepted queues association hash and all five generated artifact hashes.
The component and wrapper were copied byte-for-byte from that accepted build; `LICENSE-MONTY` retains its MIT license.
The source commit is currently local and unpushed. No remote-fetch dependency is claimed.

Verify vendored bytes:

```sh
pnpm --filter @sweatpants/flowmode-runtime-monty check
```

For a local rebuild, use a clean Monty checkout at the pinned commit and its existing guarded build tooling (`tools/coroutines/coordinator1/guarded_checks.py`, shared target/lock, at most two jobs, debug and incremental disabled).
The accepted receipt records `node crates/monty-js/scripts/build-component.mjs` under the `component` guard action; rebuild through that guard, not an unbounded direct Cargo invocation.
Then explicitly import the artifacts (refuses a different commit, dirty tracked source or changed artifact hash):

```sh
node packages/flowmode-runtime-monty/scripts/artifact.mjs /absolute/path/to/pinned-monty-checkout
```

After a deliberate manifest repin, run `node packages/flowmode-runtime-monty/scripts/artifact.mjs --generate` to regenerate the worker-safe identity module. This verifies artifact and association bytes before generating; normal `build`/`check` reject stale generated identity. The manifest must name exactly the five executable files. No runtime filesystem hashing or Wasm rebuild is needed for identity generation.

A different toolchain may produce different bytes; review and repin those deliberately rather than silently accepting them.
Regenerate JS guest strings after editing Python contracts: `node packages/flowmode-runtime-monty/scripts/guest.mjs`, then format.

## Bounds

This is a bounded Python authoring slice, not asyncio parity or a TypeScript-to-Python compiler.
One scope per task; direct-owner joins; two-argument gather over coroutine continuations; positive bounded queues without shutdown/join/task_done/timeouts/deadlock detection.
`Scope.errors` retains drained child/deferred-cleanup errors as in the accepted library; authors must inspect them if needed.
Host operation replies are strings; results are JSON-safe supported values, with safe-integer checks.
The adapter admits at most 256 host calls in a turn and configures 64 MiB guest memory, recursion 200, 1000 suspensions, and runtime duration limits.
Duration checks depend on host clock progress and do not establish CPU preemption on workerd.
No arbitrary-await snapshot, decoded-frame, hostile snapshot validation or cross-backend snapshot interchange claim.

Local UI: build yo-workflow dependencies, then `pnpm --filter yo-workflow execution:demo` and open `http://127.0.0.1:8110/execution`.
This initializes separate local D1 state and a persistent local signing key; no model credentials are needed.
Choose Python, complete B before A, restore, or cancel while a release is waiting. Repeated cancel is available during cleanup.
Scheme/Lua retain their existing compiled-tool and model-authoring paths.
