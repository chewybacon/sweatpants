# Shared execution boundary

An execution advances to one suspension or terminal outcome. A suspension may
represent a single operation, an all/race group, or a spawn/join operation; the
request vocabulary belongs to the operation contracts, not the bridge.

`foundation` declares `ExecutionBoundary`, `Execution`, `ExecutionState`, and
`Executor`. These are live computation interfaces, not a wire protocol. Request,
reply, output, and failure types are independent parameters. Transport errors
throw rather than becoming application failures. Activation is reserved for the
host episode. `ExecutionState` is only a handle/boundary pair, with no separate
lifecycle.

See [Execution vocabulary and the episode analogy](./execution-vocabulary.md) for
the collaborator responsibilities and the reasoning behind these names.

## Shared live command primitive

`createExecution(initialBoundary, driver)` owns the live state machine for both
adapters. The principal sends `resume(suspensionId, reply)` or `cancel(reason)`;
the driver receives an `ExecutionCommand` through `turn(command)`. The primitive
validates correlation before dispatch, rejects overlapping commands, retains the
current boundary, and handles terminal cancellation and idempotent disposal.

A dispatched command that throws or is abandoned leaves the handle in the
unknown-outcome state. Only disposal remains available. This includes Effection
scope cancellation, which unwinds through `finally` without entering `catch`.

The drivers contain only backend translation and domain-specific reply validation:
kernel drivers call the evaluator; tool drivers issue host turns with their
adapter-owned command IDs and cursors.

This spike shares live command discipline. It does not introduce a remote wire
protocol, a shared request pump, or a durable execution handle. Durable tool
consumers still use `advanceToolInvocation` with journal-owned command identities.

## Current adapters

- `WorkflowKernel` directly implements `Executor.start(program, input)` and adds
  snapshot restoration. Fresh and restored executions return the same
  `KernelExecution`: the shared execution handle with a `capture()` capability.
  Evaluators use `createKernelExecution(boundary, driver)` to install the shared
  command state machine once. There is no forwarding executor or WeakMap of handles.
  The evaluator supplies suspension IDs and converts its internal machine result
  into the shared boundary at its edge; the backend performs no boundary conversion.
- `tool-session.createToolInvocationExecutor(host)` starts and advances an
  ordinary invocation through the existing host. Its suspension identity combines
  the event cursor and request ID. Replies must also match the ask kind and request
  ID. Existing command deduplication and event projection remain host-owned.

Both execution paths reject overlapping commands and stale replies. A failed advance
makes the handle unavailable for further advancement: its remote outcome may be
unknown. Disposal remains available. Callers must dispose handles in a finalizer.
Cancellation may produce another suspension for cleanup; disposal does not promise
logical cleanup. A terminal boundary cannot be resumed.

### Lifecycle spike: ownership before and after startup

The tool adapter owns cleanup after `host.start` succeeds and until the first
boundary is obtained. If that advance throws or its scope is cancelled, a
finalizer disposes the invocation: no execution handle has reached the caller.
After successful startup, the caller owns disposal as before. Acquisition inside
`host.start` remains the host's responsibility.

The shared handle separates revoking advancement from acknowledging release.
Disposal immediately closes the handle to resume/cancel. Successful driver
disposal makes subsequent disposal a no-op; failed or interrupted disposal allows
the owner to retry. Concurrent disposal is rejected. There is no automatic retry.
Drivers must tolerate partial release and repeated disposal after interruption.

The executable examples are `foundation/src/__tests__/execution.test.ts` and
the abandoned-startup scenario in `tool-session/src/__tests__/invocation-executor.test.ts`.
This is a narrow spike: it does not establish retry-safe cleanup in every host or
transport. In particular, a host that forgets an invocation before release
finishes still needs its own ownership fix. Snapshot capture's lifecycle guard
and a production placement/recovery matrix remain follow-up work.

Suspension IDs are scoped to an adapter lifetime. They are not durable receipts,
and must not be used to correlate commands across reconnection or restoration.
The existing ProgramDriver retains execution epochs, ordered actions, authorization,
accepted-result receipts, replay, and checkpoint provenance.

The kernel backend starts through `Executor.start` and advances through the returned
execution. It uses the kernel executor’s separate restore/capture capability for snapshots. Ordinary tool-runtime and durable
ephemeral-tool consumers share the same boundary mapping through
`advanceToolInvocation`. They supply their existing command IDs and persist the
request cursor in their existing continuations; they do not use the live executor's
random command namespace. Transport and journal protocols remain unchanged.
The ordinary adapter exposes one ask per turn; it does not yet enforce one pending
request inside an arbitrary concurrent tool generator. Grouping such requests and
portable recovery capabilities are separate follow-up work.


## Effection composition

`KernelExecutor` and `ToolInvocationExecutor` use the existing
`definePort` convention. Composition installs a driver in an Effection scope;
consumers obtain the API facade with `Port.use()` or `Port.context.expect()`.
Startup calls remain observable through `Port.api.around({ start })`. Missing
configuration fails closed, and children inherit the installed driver.

The kernel backend installs its executor within the computation's run scope.
Both fresh and restored executions call its `start` operation. When recovery
has selected a validated snapshot, inner startup middleware invokes concrete
kernel restoration, so outer policy and observation surround either path.
That middleware is scoped to the computation and cannot change a sibling's start.
The backend retains concrete snapshot capture outside that run, reached through
the existing `ProgramRecovery` checkpoint policy and shared driver. Returned
execution handles remain bound to their live computation; resolving
another executor in a child scope does not retarget an existing execution.
Tool executor composition is exposed for live callers; durable tool paths
continue to use their journal-owned turn commands.


## Executor / transport / kernel spike

`tool-runtime-local/src/styles/__tests__/fixtures/executor-transport.ts` is an isolated comparison.
It is not installed in production paths. Its scoped `Executor` declaration has
one `createExecutor(transport)` implementation for both placements:

- Local transport constructs an operative in a resource scope.
- Worker transport connects to the same operative dispatcher in a real worker.
- Each connection owns one live execution and carries only start/resume/cancel/dispose
  messages and boundary/disposal/rejection responses.
- The operative owns the kernel and execution handle. No live handle crosses the
  transport. Explicit disposal closes the worker scope; scope exit also closes it.

The same scenario body runs a deterministic request-list program against both
placements: question, model request, completion; cancellation with cleanup; and
stale reply rejection. Local exchange clones payloads to match worker isolation.

The fixture kernel implements the existing `Executor` interface on the operative
side. This reveals a useful composition: an executor can itself be the implementation
behind a transport-backed executor. A new universal kernel interface is not needed
for this experiment. Production Scheme/Hoot integration, recovery, wire validation,
multiplexing and remote authentication remain outside the spike.

### Real Hoot recovery composition

`experiments/workflow-kernel/executor-recovery` extends the comparison with the
real Hoot fixture and existing `ProgramRecovery` middleware. `Executor.start`
middleware selects recovery from an authority-planned input; mandatory validation
surrounds the recovery policy. Scoped policy chooses snapshot + accepted suffix
or full replay. Boundary response envelopes carry checkpoint metadata for the
principal to persist; the common executor interface remains unchanged.

Both local and worker tests destroy the first connection, restore an earlier
checkpoint in a fresh connection, replay the suffix, and finish pending cleanup.
They assert actual Hoot restore/start/resume events and independent connection
policies. Receipts are manufactured fixtures, not an authority admission proof.

Unlike the simple request-list fixture, this composition needs dispatch to stay
inside its operative scope. Its local transport therefore uses a message queue
owned by that scope: returning an API facade alone does not retain middleware.
The backend now consumes the kernel's shared handle directly. Concrete capture
and restore remain evaluator capabilities underneath the recovery policy.

The kernel backend now uses this startup composition in its package implementation,
with regression coverage for observing both paths and isolating restored/fresh
siblings. The experiment's transport envelope and trusted-plan start payload
remain experimental; they have not replaced the existing program driver protocol.

## Attachment integration

The attachment now drives both Effection and snapshot-capable kernels through
`ProgramComputation.start()` and one shared execution loop. Backend-specific
work is preparation, request/reply translation, and checkpoint support. See
[Attachment container and evaluator kernels](effection-container.md) for the
call stack and lifecycle responsibilities.
