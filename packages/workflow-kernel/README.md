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

`createKernelExecution` delegates to foundation's `createCheckpointExecution`.
Its handle is a `CheckpointExecution` with a typed `capture` capability. Replay
executors use `createExecution` and expose no capture method. Both factories
accept construction-time middleware using Effection's `Around` types, surrounding
the mandatory per-execution discipline. Capture uses the same guard as resume,
cancel and dispose; the factory exposes no arbitrary `observe(callback)` method.

Program code and snapshot state are `Json` at this seam; their owning
kernel validates their formats. Compatibility checks do not establish content
integrity, authorization or accepted journal provenance. Fresh restoration may
still be followed by accepted journal suffix recovery through the shared driver.

## Inspection

`ExecutionInspection` is a read-only projection, never a checkpoint or a resume
capability. Projection currently stays in the Hoot adapter; inspection adds no
required methods to `WorkflowKernel` or `WorkflowExecution`.

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

## Exchange and authoring seams

The semantic primitive is `Exchange<Request, Reply> = (request) => Operation<Reply>`.
`Flow` receives input and an exchange capability; `ExchangeMiddleware` wraps that
capability. These are live functions, never checkpointed JavaScript stacks.

`createWorkflowFlow(start)` implements `WorkflowFlow`. Its startup callback takes
the input and returns a fresh or restored `WorkflowExecutionState`. The flow calls
`exchange(request)` at each guest suspension, supplies the reply to the guest,
and returns its completed value. An uncaught guest error raises `WorkflowFailure`
with the original JSON value. `DurableProgramCancellation` raised by an exchange
requests guest cancellation; cleanup can make further exchanges. Other exchange
errors propagate without being injected into the guest.

The backend invokes this Flow through the existing `EffectionKernel`, which
exposes exchanges as record boundaries to the shared attachment driver. The owner
retains the guest execution for capture and disposal, including after completion.
Restoration rebuilds this live bridge around the saved guest boundary, without
executing the guest prefix. Only VM state is checkpointed; any future exchange
middleware must tolerate activation restart. Disposing the bridge halts host
compute and releases the VM without requesting logical guest cancellation.

`WorkflowExchange` specializes it with `{ site, binding, input }` requests and
`value | throw` replies. Site is diagnostic; binding selects a declared capability.
The journal's pull ID supplies durable identity. Cancellation and disposal remain
separate execution commands. Cancellation may produce cleanup exchanges; disposal
only releases compute. Language adapters decode their private request encodings.

`WorkflowCompiler.compile` accepts source, an entry, explicit `WorkflowExport`
declarations and imported binding declarations. It returns structured diagnostics
or a `CompiledWorkflow`. Each export maps a public name to a guest entry and a
schema-bearing contract supplied by the host/extractor. Compilation never invents
schema identities. Lua compilation checks syntax, not static types.

`WorkflowLinker.link` accepts a compiled caller and resolved bindings. Compiled
bindings name a module export; host bindings reference a versioned capability;
child bindings pin an existing durable program. Compiled helpers share the guest
continuation. Host/child calls cross the exchange boundary. Hoot's SDK context
placeholder is private to its calling convention.

`assertWorkflowLink` checks imports, duplicate bindings and export schema contracts.
Export aliases can have different local names/IDs while retaining the exported
input/output schema identities. Resolution and authorization remain distinct.
`program-backend-kernel` resolves exchanges to the existing operation descriptors;
the existing authority validates and journals their outcomes. No second driver loop
is introduced. Bundle digests include code, identity, manifest and binding catalog.

Compiler/linker operations use Effection; bundler and HTTP entry points bridge
with `run`. Preflight is a separate bounded kernel execution without host dispatch.
Restoration uses the pinned artifact and snapshot, never an authoring callback.

`WorkflowRuntime` owns kernel identity and acquisition. Source language, target
format and runtime identity stay separate. Snapshots do not become interchangeable
merely because both adapters implement these interfaces.

Inspection reports availability for calls, environments and unwind independently.
An unavailable projection must not be displayed as an empty guest stack.

The directive build recognizes a statically analyzable
`createDurableTool(...).execute(namedGenerator)` with `"use workflow"`. Normal
imports retain the SDK `DurableTool`. A separate `.artifact.mjs` exports the
`CompiledWorkflow`, with declarations inferred from the tool's input/output types.
The linker and yo-workflow import that artifact explicitly. The compiler never
executes arbitrary author modules to discover their declarations.

## Operation composition

Effectful factories share foundation's `OperationOptions<Driver, Operations>`:

```ts
const compiler = createWorkflowCompiler({
  driver: languageCompiler,
  middleware: [{
    *compile([request], next) {
      const result = yield* next(request);
      return result;
    },
  }],
});
```

`createWorkflowAuthoring`, `createWorkflowCompiler`, `createWorkflowLinker`,
`createWorkflowRuntime`, and `createWorkflowKernel` use this shape. Metadata stays
on the driver; middleware keys describe only operations. The first middleware
entry is outermost. These wrappers preserve the calling Effection scope and do
not acquire resources until the wrapped operation runs.

The same foundation `OperationMiddleware<Operations>` type is used by execution,
durable storage, chat APIs, and tool invocation hosts/executors. Existing scoped
Ports keep scope inheritance and driver installation. `installOperationMiddleware`
installs the shared middleware shape through their existing `api.around` mechanism;
it does not turn scoped capabilities into globally retained handles.

Middleware is trusted live code and is not serialized. It may intercept results,
so it is not an authorization boundary. Execution command discipline and storage
transaction checks remain inside the driver path, present without middleware.
Replay executions need no capture capability; checkpoint executions coordinate
capture with advancement and disposal through their shared instance guard.
