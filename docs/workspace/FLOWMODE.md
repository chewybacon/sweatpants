# Flowmode in the current framework

Flowmode runs compiled workflows in Lua and Scheme kernels. It supplies portable
kernel checkpoints and explicit execution boundaries. The JavaScript iterator
foundation supplies a smaller live Guest capability. They share lifecycle
enforcement without pretending that every Guest can capture a checkpoint.

## Source map

| Package                                             | Responsibility                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `flowmode-compiler`                                 | Analyzes and lowers supported authored source; compilation is not arbitrary JavaScript execution. |
| `flowmode-compiler-lua`, `flowmode-compiler-scheme` | Target-specific compilation.                                                                      |
| `flowmode-runtime`                                  | Program/kernel identity, exchanges, snapshots, execution contracts and composition.               |
| `flowmode-runtime-lua`, `flowmode-runtime-scheme`   | Evaluator implementations and target-specific state validation.                                   |
| `flowmode-backend`                                  | Binding and host integration, including adapting kernel Guests to durable program execution.      |
| `foundation`                                        | Shared Guest/Execution contracts, command discipline and optional checkpoint capabilities.        |

`apps/yo-workflow` remains a playground and inspector. It is not evidence that all
former chat/deployment integrations support compiled workflows.

## Kernel boundary

A `WorkflowProgram` contains a digest, kernel identity and target code. A
`WorkflowKernel` can start a program or restore a compatible `KernelSnapshot`.
Both return a boundary plus a live execution handle.

```text
authored source → compiler → pinned WorkflowProgram
  → kernel.start(program, input) or kernel.restore(program, snapshot)
  → suspended exchange / terminal boundary
  → host handles exchange and supplies correlated reply
  → execution.resume(suspensionId, reply)
```

`ExchangeRequest` carries `site`, `binding` and JSON `input`. `ExchangeReply` is a
value or throw reply. The kernel stops at external requests; advancing it does not
execute those effects. Native Operation wrappers allow scheduling or transport,
but do not make an unbounded synchronous Wasm computation interruptible. Evaluators
must bound their compute slices.

A kernel snapshot contains kernel identity, program digest and portable state.
Journal position and receipt authority belong to the host envelope. Compatibility
currently requires exact kernel kind/version/program-format/snapshot-format and
matching program digest. This is a check, not a snapshot migration policy. Artifact
loading owns content-digest verification; target runtimes validate target formats.

## Guest and Execution

`createKernelExecution` uses foundation's checkpoint execution wrapper to enforce
resume/cancel/dispose/capture discipline. Optional inspection returns detached
diagnostics; inspection is not a recovery capability.

`createKernelGuest` adapts the live kernel to `Guest<Json, ExchangeRequest, ...>`.
It exposes cancellation and capture alongside that Guest. `startKernelGuest` maps
requests into the retained host's operation descriptors and suspension protocol.
This adapter is a remaining ProgramDriver integration, not a new authoring API.

Logical cancellation can produce cleanup exchanges. Repeated cancellation must not
interrupt cleanup. Physical disposal releases evaluator resources without logical
unwind. A successful capture must detach portable state from live JS/Wasm handles.

## Recovery is not one mechanism

For an ordinary iterator tool, a parked activation closes its Guest. The next
activation reconstructs the generator and replays accepted outcomes. It does not
serialize the JS continuation.

Flowmode can restore kernel state without executing the prefix. The host still
owns the journal, accepted outcomes and recovery policy around that checkpoint.
Checkpoint capture by itself does not prove an external effect was accepted.

These approaches share advancement and lifecycle concepts. Keep checkpointing,
correlated Execution and the smaller Guest capability distinct where their
semantics differ. The shared guard is a useful unification; another combined
execution interface would not remove the underlying responsibilities.

Sources: [kernel contracts](../../packages/flowmode-runtime/src/index.ts),
[execution wrapper](../../packages/flowmode-runtime/src/execution.ts),
[backend Guest adapter](../../packages/flowmode-backend/src/guest.ts),
[compiler](../../packages/flowmode-compiler/src/compiler.ts).
Evidence: [journal recovery](../../acceptance/__tests__/flowmode/journal-recovery.acceptance.test.ts),
[backend](../../acceptance/__tests__/flowmode/backend.acceptance.test.ts).
