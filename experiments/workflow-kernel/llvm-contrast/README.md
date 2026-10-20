# LLVM contrast: executable evidence

This manual probe uses scriptc 0.3.6, installed outside the workspace. It compiles
an ordinary TypeScript generator with a mutable captured value and yielding
finally to LLVM IR and a native x86_64 Linux object. The object was linked with
GCC against the exact runtime objects listed by scriptc's native-link-info.
No scriptc dependency is added to the product or workspace.

Observed output matches Node for all nine boundaries in `probe.ts`:

- Normal resume: approval → cleanup with updated capture → pending return.
- Generator return: approval → cleanup → requested return value.
- Repeated generator return during cleanup: immediately completes, replacing
  the pending return. This differs from our idempotent cancellation rule,
  which preserves a pending cleanup exchange.

LLVM output contains llvm.coro.id/begin/save/suspend/free/end and heap-backed
coroutine frames. This is executable evidence for generator/closure lowering,
not for portable checkpoint restoration or workflow cancellation semantics.

## Reproduce (Linux x64, Node 24+, GCC)

Install scriptc 0.3.6 in an isolated temporary directory, then copy `probe.ts`
there. Its normal installation script prepares its bundled native toolchain.

```sh
scriptc build probe.ts --emit llvm -o probe.ll
scriptc build probe.ts --emit obj --print native-link-info -o probe.o > link-info.json
node probe.ts
```

Link with the ordered objects from `link.input_order`, `-pthread`,
`-Wl,--gc-sections`, and each library in `link.system_libraries` as `-lNAME`.
The emitted target is already x86_64 Linux; omit clang's `-target` pair when
using GCC as the linker driver. Run the binary and compare its stdout with Node.

Our recorded source, LLVM, object/link manifest, and execution outputs live under
`.artifacts/llvm-contrast/`. Installation and raw working artifacts are in
`/tmp/workflow-llvm-probe/` for this session.

## What changes for a workflow kernel?

| Concern               | Current Scheme/Lua kernels                    | LLVM/scriptc route                                                               |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Language lowering     | Bounded workflow Scheme, Lua translator       | Broad typed TS IR, closure conversion, coroutine lowering already present        |
| Calls and captures    | Explicit evaluator state / managed VM heap    | Native calls plus generated heap coroutine frames and capture cells              |
| Park and resume       | Existing typed exchange frontier              | Generator channels exist; workflow host ABI still needed                         |
| Repeated cancellation | Pending cleanup is preserved                  | Standard generator return interrupts cleanup; requires explicit workflow control |
| Fresh restore         | Proven logical snapshots in both Wasm kernels | No logical serializer demonstrated; frame/code/heap identity must be designed    |
| Inspection            | Existing call/environment/unwind projections  | Source metadata exists; optimized frame projection needs separate work           |
| Embedding             | Existing Wasm instance and DO architecture    | Wasm executable supports async; documented library/reactor mode is async-free    |
| Optimization          | VM/evaluator costs                            | LLVM optimization opportunities; no comparative benchmark performed              |

LLVM IR serialization is serialization of the program, not the suspended
execution. Raw Wasm memory capture would be a different checkpoint contract,
with tables/globals/host state and exact artifact identity to account for.
An alternative is explicit durable frame/state lowering before LLVM, preserving
our logical snapshot model; that requires additional compiler/runtime work.

Pinned source research and references are in the shared workspace's
`notes/workflow-native-compiler-research.md`. The executed npm release is 0.3.6;
source research at a pinned main-branch commit is not claimed to be the exact
source revision of that published binary.
