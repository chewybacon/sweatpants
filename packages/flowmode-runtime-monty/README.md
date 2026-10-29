# Monty workflow runtime

Actual Rust Wasm execution through the existing Flowmode kernel and journal-authority backend.
The Python author writes `async def main()`, imports `asyncio` and `sandbox.read_file`, and awaits ordinary variadic `asyncio.gather`.
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

## Artifacts and source association

The manifest pins every executable and the complete source association to Monty
commit `6ab9e345ccfb8ea1733cbb910e935649bacb75ed` (currently local/unpushed).
All recorded runtime and build inputs match that committed source. The association
retains the original dirty-build receipts and subsequent documentation-only update;
committing those exact inputs required no rebuild. Vendored bytes allow execution
without a sibling checkout. The MIT license is retained.

`pnpm --filter @sweatpants/flowmode-runtime-monty check` verifies vendored bytes and
the generated complete-manifest identity. An explicit local import using
`node packages/flowmode-runtime-monty/scripts/artifact.mjs /path/to/monty` verifies
HEAD, the recorded dirty patch (or cleanliness for an immutable pin), every source
input and every artifact hash before copying. It never silently repins.

Build through `tools/coroutines/coordinator1/guarded_checks.py` (`native`, `wasm`,
`component`): shared lock/target, max two jobs, debug/incremental disabled,
10 GiB minimum free space and 8 GiB combined cache cap. After deliberate review of
a repin, `artifact.mjs --generate` updates the static worker-safe manifest digest.

## Python authoring

```python
import asyncio
from sandbox import read_file

async def main():
    paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]
    return await asyncio.gather(*(read_file(path) for path in paths))
```

Imports use Monty's real module/name machinery. The supplied `sandbox` module
creates lazy, serialized continuations. Awaiting a read emits
`{capability: "sandbox.read_file", arguments: {path}}`. The host owns authorization,
fulfillment and persistence. This never opens an OS file. Replies select an issued
operation ID and contain either a bounded string value or a supported Python
exception type/message. The Execution demo fulfills only an explicit local fixture
map; its UI offers each pending read separately. One journal elicitation still
represents the entire frontier, preserving existing revision/capability authority.

The platform selects the durable dialect and starts `main` internally; neither
private entry calls nor injected globals are required in authored source. Native
`asyncio.gather` is variadic, including starred generator expansion, and adapts
durable continuations using VM-owned frozen functions. No coroutine state lives
outside the snapshot. `guest/cleanup.py` demonstrates ordinary `try/finally` and
`async with` with yielding reads during cancellation. The app's bounded `cleanup`
example is available via the public start command's `example` field.

## Bounds

This is a bounded Python subset, not full asyncio parity or a Python compiler for
TypeScript tools. Gather keywords including `return_exceptions` remain unsupported.
The internal legacy Scope/Queue bindings remain available for runtime regressions;
Scope is cancel-on-exit and is not presented as `asyncio.TaskGroup`. Standard Queue
is not supplied. The adapter admits at most 256 calls per turn, with 64 MiB guest
memory, recursion 200 and 1000 suspensions. Host replies are bounded strings or
listed exceptions, and results are supported JSON-safe values. Duration checks
are not workerd CPU preemption. Snapshots must be trusted compatible producer output.

Run `pnpm --filter yo-workflow execution:demo`, choose Python and Run five reads.
Fulfill reads in reverse order or restore between replies. Scheme/Lua retain their
existing paths. No model credentials or external production effects are required.
