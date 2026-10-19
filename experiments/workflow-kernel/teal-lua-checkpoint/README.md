# Piccolo Lua workflow kernel experiment

The current increment runs **ordinary Lua**, through the shared `WorkflowKernel`
and `WorkflowRuntime` interfaces. Teal and TypeScript-to-Lua compilation are
postponed. This folder retains the original experiment name.

## What works in the demonstration

- Start a Lua program with JSON input and yield host requests.
- Resume with a value or a thrown value.
- Capture frames, tables, closures and shared/open upvalues as a JSON graph.
- Restore in a fresh Wasm instance or native process without executing the guest prefix.
- Keep aliases and cycles inside the guest heap.
- Preserve a return, error or cancellation across cleanup that itself yields.
- Cancel while parked, or while cleanup is already parked. Repeated cancellation
  leaves the pending cleanup boundary intact and preserves the first reason.
- Use the shared execution command state machine and content-addressed bundle
  helpers. No parallel execution protocol or runtime registry is introduced.

The execution lab runs this kernel as Wasm on Node and in Cloudflare Durable
Objects, through the shared backend/driver and journal. The native CLI remains
available for the standalone VM demonstration. Demonstration runs are not full
kernel conformance, malicious-snapshot coverage, or deployment certification.

## Authoring plain Lua

```lua
return workflow.scope(function()
    local answer = workflow.effect("approval", { binding = "approval", input = input })
    if answer == false then error("declined") end
    return { approved = true }
end, function(completion)
    workflow.effect("cleanup", { binding = "cleanup", input = { completion = completion.kind } })
end)
```

The source is a Lua chunk with a local `input` and one JSON result. The runtime
prepends `prelude.lua`, which implements `workflow.scope` using protected calls.
Cleanup receives `{ kind = "return" | "throw" | "cancel", value = ... }`.
A cleanup error supersedes the pending completion. Cancellation arriving during
an existing cleanup lets that cleanup finish; successful completion then becomes
cancelled. Raw Lua protected calls can catch the injected cancellation error, but
the host cancellation flag still prevents successful terminal completion. This
is cooperative Lua cancellation, not an uncatchable exception mechanism.

Guest code has functions, closures, tables, normal Lua control flow, arithmetic,
plus `pcall`, `error`, `assert`, and `type`. The environment does not expose
ambient I/O, dynamic loading, metatable APIs, arbitrary coroutines, or the full
Lua standard library. Host requests are inert data until an authorized host
handles them. A site name alone does not grant a capability.

### Boundary values

Plain string-keyed tables become JSON objects. Contiguous positive numeric keys
become arrays. `workflow.array({})` represents an empty array; `workflow.null`
represents JSON null. Use `workflow.is_null(value)` to recognize incoming nulls
rather than comparing table identity. Lua nil returned at a boundary also maps
to JSON null. The marker keys `__workflow_json_array` and
`__workflow_json_null` are reserved and rejected in incoming JSON objects.

Boundary values require UTF-8 strings, finite numbers within JavaScript's safe
integer magnitude, at most 32 levels and 10,000 traversed values. Sparse/mixed
array tables, cycles, functions and native values cannot cross the boundary.
The checkpoint heap is a separate encoding: it preserves cycles, byte strings,
and exact integer/float bits. Integer/bit payloads are decimal strings so a
JavaScript JSON round-trip cannot lose precision.

## Runtime and persistence

`kernel.mts` implements the existing lifecycle over an injected command operation.
`wasm.mts` creates a fresh Wasm instance for each command and discards it after
reading the JSON result. Only the compiled module is cached. `native.mts` keeps
the standalone subprocess demonstration; it is not imported by the app or DO.
The shared `createKernelExecution` owns suspension-ID checks and live command
ordering. Disposal/close releases compute without logical cleanup.

Both transports accept the same source/input/state command and return the next
state. Restore reconstructs state without stepping it. The adapter assigns fresh
activation-local suspension IDs after restore.

`createLuaProgramBundle` uses the existing content-addressed bundle helper;
consumers use `loadKernelProgram` before start/restore. The runtime envelope also
binds the combined source/prelude to the runtime version. Capture returns an
opaque kernel snapshot: no pointers, Wasm memory, Rust stack or JS handles.

The runtime loop returns from `Lua::enter` between fuel slices so incremental GC
can run. Limits include 64 KB source, 4 MB command/output, 1,000 slices of 1,000
fuel and a 32 MB arena check between slices. Wasm linear memory has a hard 64 MB
maximum, including compiler/checkpoint allocations; allocation failures trap the
instance. Wasm executes synchronously with the runtime's fuel budget (not a JS
wall-clock timer). The native CLI additionally has a 10-second parent deadline.
Neither sandbox provides a hostile-checkpoint control-flow verifier.

## The Piccolo patch

Pinned upstream: `kyren/piccolo` at
`ce709eb1dae5c543cbc78e7e12bb80249d88c55f` (0.3.3), with gc-arena pinned by that
revision. `prepare.py` verifies the upstream archive SHA-256 and applies
`piccolo-checkpoint.patch` into `.artifacts/teal-lua-checkpoint/piccolo`.
Cargo.lock pins the Rust dependency resolution.

The patch adds:

1. A thread-owned snapshot codec with stable graph/prototype/capability IDs.
2. Narrow internal access to open-upvalue thread/slot references.
3. An explicit `SequenceCheckpoint::ProtectedCall` representation for the
   stateless `PCall` continuation. All unknown native sequences still fail capture.
4. Conversion of caught native errors to Lua strings before a protected handler
   can yield. Lua-raised error values remain intact. This is a deliberate change
   to upstream PCall's native-error representation for this experimental fork.
5. Pre-allocation graph/reference checks, closure counts, open-cell completeness
   and ordering, basic frame geometry, duplicate/invalid table keys, and aggregate
   graph/string budgets. Capture also counts traversal work before growing the
   snapshot. Restore allocates shells, connects cells/closures/tables, then installs
   frames and the yielded sentinel.
6. Infer the math RNG seed length from the target RNG type, fixing the upstream
   32-byte assumption on 32-bit Wasm (math is not exposed to workflow code).

**Snapshots remain trusted persistence artifacts.** The checks are not a full
bytecode/control-flow verifier. Arbitrary edited frame PCs or return metadata are
not a supported input or a security boundary. A hostile-snapshot loader and its
rejection coverage remain unfinished. The Wasm/process boundary bounds failures; it
does not authenticate snapshots or grant journal provenance.

## Build and run

From the repository root (Docker, Python 3 with tarfile data filtering, and
`patch` required):

Build the app's Wasm artifact (also prepares the patched VM when absent):

```sh
pnpm --filter yo-workflow execution:lua:build
```

This writes `.artifacts/teal-lua-checkpoint/kernel.wasm`. The ABI exports memory,
allocate, execute, and output_len. Its only import is host.random_fill, supplied
by Web Crypto for internal hash-table entropy. It requires no WASI or Wasm-bindgen
runtime. Cloudflare loads the static module through `#execution-lua-wasm` alongside
the existing Hoot Wasm imports. Both authoring validation and execution use it.

For the optional native demonstration:

```sh
python3 experiments/workflow-kernel/teal-lua-checkpoint/prepare.py

docker run --rm -v "$PWD:/work" \
  -w /work/experiments/workflow-kernel/teal-lua-checkpoint \
  -e CARGO_HOME=/work/.artifacts/teal-lua-checkpoint/cargo \
  rust:1.88.0-slim cargo build --locked

NODE_OPTIONS=--conditions=development node --import tsx \
  experiments/workflow-kernel/teal-lua-checkpoint/demo.mts approve
```

Other demo modes: `decline`, `throw`, `cancel`, `cancel-cleanup`. Each writes its
snapshots and trace under `.artifacts/teal-lua-checkpoint/<mode>-<timestamp>/`.
The demo JSON-round-trips every checkpoint and closes/reacquires the kernel
before continuing. It shows each boundary and repeated cancellation explicitly.

The compiled executable must run on a compatible Linux host. `prepare.py` refuses
to overwrite an existing prepared directory; preserve or remove that disposable
artifact explicitly before preparing a changed patch. The compiler image tag is
versioned but is not pinned by image digest.

## Evidence and next increment

The approval demo produced `prefix → approval → cleanup → completed`, retaining
both closure observations (`4`), the alias/self-cycle and count (`17`). Decline and
host-throw reached cleanup then failed with their original errors. Cancellation
at approval and cancellation during cleanup both preserved cleanup across
restore and ended cancelled. Repeated cancellation returned the same live
cleanup boundary. The prefix request occurred once in each trace.

Rust builds, strict kernel/demo TypeScript and focused lint are recorded under
`.artifacts/teal-lua-checkpoint/`. No automated tests were added or run, and the
full repository landing gate was not run for this increment.

Next: complete conformance and restore hardening. Compiler-free restore,
semantic inspection of Lua environments/unwind, durable children, and Teal
remain later work. Source is recompiled to construct prototypes on restore;
guest instructions before the saved point are not replayed. Native/Wasm
checkpoint interchange is not a certified compatibility guarantee.

## Execution lab language selection

Both the Node and Durable Object yo-workflow execution endpoints now list Scheme and Lua. Each stack owns
its validator, developer definition preparation, linker, program factory, default
caller, and model instructions. A run persists its language with its authored
source; restore resolves that same stack. The existing kernel backend, program
driver, and journal protocol are shared.

`authoring.mts` implements the effectful compiler/linker/validator seams. The Lua
compiler accepts a named module returning a function; it uses Piccolo's compiler
without executing the module. The linker composes these definitions and explicit
host bindings with the caller, then compiles the linked source for admission.
This checks Lua syntax, not static types. Teal and TypeScript-to-Lua lowering are
not implemented. Scheme retains the TypeScript `"use workflow"` developer surface;
the Lua confirmation fixture is authored in Lua.

The Wasm artifact must be built as described above before starting the app.
Cloudflare advertises both Scheme and Lua. There is no fallback between languages and no snapshot migration.

Inspection exposes compiled function references and raw continuation frames.
Lexical binding names and semantic unwind projections are not implemented for
Lua. The UI leaves unavailable step counts and current environments null. Restore
compares the captured computation state with the accepted checkpoint for both
runtimes. Prototype line numbers refer to the linked source including the prelude.
