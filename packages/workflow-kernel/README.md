# @sweatpants/workflow-kernel

Portable program/snapshot identities, evaluator lifecycle, compatibility checks,
and a detached inspection contract. The current integrated implementation is the
experimental Hoot evaluator in `experiments/workflow-kernel/hoot-composition`.
Building this package produces TypeScript declarations and ESM, not Wasm.

## Execution and ownership

The kernel owns calls, lexical environments, scopes and cleanup. It advances to
an effect or terminal boundary. The shared `program-backend-kernel` adapter binds
requests to existing durable operations; the shared driver and journal own
protocol position, accepted outcomes, authorization and recovery provenance.

- `start` advances a pinned program to its first boundary.
- `resume` addresses a suspension on a live execution handle.
- `cancel` requests logical unwind and may suspend for cleanup.
- `capture` exports computation state in the kernel's format.
- `restore` reconstructs the boundary without executing the prefix.
- `dispose`/`close` release compute without logical cancellation.

The existing execution state machine serializes command discipline and rejects
stale suspension IDs. Callers must serialize operations on a handle. Effection
operations do not make synchronous Wasm interruptible: kernels must bound compute.

Program code and snapshot state are `unknown` at this seam because their owning
kernel validates their formats. Compatibility checks do not establish content
integrity, authorization or accepted journal provenance. Fresh restoration may
still be followed by accepted journal suffix recovery through the shared driver.

## Inspection

`ExecutionInspection` is a read-only projection, never a checkpoint or a resume
capability. Projection currently stays in the Hoot adapter; inspection adds no
required methods to `WorkflowKernel` or `KernelExecution`.

- `boundary` omits the activation-local suspension ID, which can change on restore.
- `calls` lists outermost to innermost callers; IDs are inspection-local.
- `environments` describe lexical ancestry and bindings, independently of calls.
- `unwind` lists innermost to outermost scope, cleanup and finally continuations.
- `PendingCompletion` preserves return, throw, cancellation and loop transfer.
- Values are bounded display summaries or callable/closure descriptions. Closure
  environment IDs expose lexical sharing; this is not a general heap graph.
- `truncated` signals omitted entries or shortened displayed values. Referenced
  environments may be omitted when the collection budget is exhausted.

Hoot does not retain frame-to-environment ownership or the original scope identity
while cleanup runs. The contract does not invent those relationships. A running
cleanup's `remaining` list excludes its currently executing callback.

The lab consumes this projection for calls, lexical bindings and unwinding. It
also retains Hoot-specific diagnostic data for raw continuation display, evaluator
step counts and checkpoint explanations. Those diagnostics are not this contract.
No host capability is granted by inspection data, and the same access policy as
other execution diagnostics must protect it.

## Validation

Package tests cover compatibility and live command discipline. The lab's
`execution:test` also runs the Hoot inspection proof and its TypeScript check:
caller/callee composition, environment references, return/throw/cancel cleanup,
repeated cancellation, finally, fresh restore, detached views and explicit limits.
The existing journal/inspector behavior checks remain unchanged.

This increment defines the seam around Hoot. It adds no kernel registry, compiler
backend, cross-kernel checkpoint compatibility, or source migration.

## Authoring and runtime seams

`CompiledWorkflow` is the shared output of a directive compiler. It carries an
entry, source/source-language, debug metadata and a `WorkflowImplementation`
containing `{ format, payload }`. Type parameters preserve developer inference;
they do not generate schemas or prove portable captures.

`WorkflowLinker` combines language-tagged caller source and explicit bindings:
compiled guest functions have a definition and portable prefix arguments; host
capabilities have a public name and contract version. Linking does not authorize
capability use. `WorkflowSourceValidator` performs language-owned admission and
returns diagnostics without dispatching effects. The host can then preflight via
`WorkflowKernel.start` and close compute at the first boundary.

`WorkflowRuntime` owns kernel identity and acquisition. The existing backend
preparation contract extends it and separately supplies artifact loading. Runtime
placement, executable format and source language are different choices.

There is no universal instruction encoding. The current Hoot linker accepts
`workflow-scheme-definitions-v1` definitions and emits `workflow-scheme-spike-1`
programs. Another target must produce its own format and preserve the agreed
execution, cleanup and boundary semantics. Formats and snapshots are not
interchangeable merely because their TypeScript envelopes have the same shape.

`WorkflowCompiler` is the pure source-to-definitions seam: it declares its source
language and output definition format, accepts source with an optional file ID,
and returns named portable exports. The tsdown plugin now only wraps this compiler
output as ESM; the runtime does not depend on bundling or the compiler.
