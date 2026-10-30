# Monty workflow runtime

Actual Rust Wasm execution through the existing Flowmode kernel and journal-authority backend.
The Python author writes `async def main()`, imports `asyncio` and `sandbox.read_file`, and awaits ordinary variadic `asyncio.gather`.
See `guest/demo.py` and acceptance coverage in `acceptance/__tests__/monty/`.
Rust owns task scheduling, queues, cancellation scopes and yielding cleanup.

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
`e5077481b13a4e9de83cdaca90aff3ae638281be`. Every runtime and build input matches that committed tree.
The preserved build association records the original dirty build; `buildSourceCommit`
and `buildSourcePatchSha256` retain its provenance. The executable bytes are unchanged.
The accepted scope association is retained as provenance.

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

The host feeds the authored source unchanged, then invokes public `asyncio.run(main())`
in a separate feed. There is no dialect import, private entry or source rewriting. Native
`asyncio.gather` is variadic, including starred generator expansion, over ordinary coroutines. Supplied sandbox capabilities are native coroutines with
VM-owned frozen implementations. No coroutine state lives
outside the snapshot. `guest/cleanup.py` demonstrates ordinary `try/finally` and
`async with` with yielding reads during cancellation. The app's bounded `cleanup`
example is available via the public start command's `example` field.

## Bounds

This is a bounded Python subset, not full asyncio parity or a Python compiler for
TypeScript tools. Gather keywords including `return_exceptions` remain unsupported.
Public `asyncio.create_task`, Task handles, `TaskGroup` and `Queue` are supported.
`import anyio` supplies `create_task_group`, owner-only `start_soon`, `cancel_scope`,
`CancelScope(shield=True)` and `get_cancelled_exc_class`. See the bounded reference below. The adapter admits at most 256 calls per turn, with 64 MiB guest
memory, recursion 200 and 1000 suspensions. Host replies are bounded strings or
listed exceptions, and results are supported JSON-safe values. Duration checks
are not workerd CPU preemption. Snapshots must be trusted compatible producer output.

Run `pnpm --filter yo-workflow execution:demo`, choose Python and Run five reads.
Fulfill reads in reverse order or restore between replies. Scheme/Lua retain their
existing paths. No model credentials or external production effects are required.

## Playground evaluation

`createMontyEvaluationDriver` and `MontyEvaluationPort` provide disposable compute
turns for the conversational Playground. The explicit playground profile accepts
the installed `sandbox` contract names and bounded JSON replies, using a distinct
snapshot identity. The default Execution profile still accepts only its read-file
contract and legacy exchange. The application validates capability schemas and
journals effects; the interpreter never performs these effects itself.

## Supported public concurrency

Both surfaces use the same Rust scheduler, snapshots and host journal. Define
`async def main()`; the host invokes it with `asyncio.run`. Do not call `anyio.run`.
The normal group exit waits for children. Failure cancels/drains siblings, reporting
`RuntimeError` with actual exception tuples rather than `ExceptionGroup`. Only the
entering task may call AnyIO `start_soon`; groups and scopes are single-use.

```python
import anyio
from sandbox import read_file

async def worker(path):
    try:
        await read_file(path)
    finally:
        with anyio.CancelScope(shield=True):
            await read_file("cleanup-" + path)

async def main():
    async with anyio.create_task_group() as group:
        group.start_soon(worker, "a.txt")
        group.start_soon(worker, "b.txt")
    return "done"
```

Use `with anyio.CancelScope() as scope`, `scope.cancel()`, `cancel_called` and
`cancelled_caught` for lexical guest cancellation. The read-only shield masks
ancestor guest cancellation, not its own scope or the first host signal. Scopes
belong to the constructing task/run. `get_cancelled_exc_class()` returns `ValueError`;
ordinary ValueErrors are not treated as scope cancellation signals. Guest cancellation
repeats at supported checkpoints; protect yielding guest cleanup explicitly.
Host cancellation automatically protects native cleanup and remains terminal even
if guest code catches its signal. Repeated cancellation retains the first reason
and pending cleanup. The host must still authorize every effect reply.

Execution supports `example: "anyio"` for shielded cleanup. Playground Stop sends
journal cancellation into the VM and can park on cleanup interactions, including
across reload. An Ask cancel remains a returned action. Disposal/abandonment runs
no authored cleanup. Internal coroutine/Queue steps are not external I/O boundaries.
No deadlines, sleeps, streams, writable shields, `anyio.run`, full backend parity,
async generators, arbitrary generator awaitables or general filesystem/network
access are supplied. Historical incompatible executable identities are rejected
before loading; older absent runtime roles are never inferred by the adapter.
