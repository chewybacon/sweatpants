# Attachment container and evaluator kernels

A host activation attaches durable work to a resource-owned container. The
existing program attachment is that container; it is not wrapped in another
lifecycle object.

```text
Host activation
  ProgramDriver.attach / restore
    ProgramBackend.open                 prepare pinned code and recovery data
    openProgramAttachment               container scope and durable protocol
      ProgramComputation.start
        EffectionKernel.start           generator + scoped effect runtime
        or KernelExecutor.start         evaluator; restore middleware may substitute
      driveProgramExecution             one shared loop
        Execution.resume / cancel
```

The attachment owns action ordering, authorization, receipts, pending attempts,
and teardown. The kernel owns evaluating code to a boundary and advancing its
live execution. The journal authority owns accepted history outside both.

## Requests and replies

```text
Authored operation
  → kernel suspension
  → attachment's shared driving loop
  → attachment protocol
  → host / journal authority

Accepted outcome + receipt
  → attachment validates receipt
  → shared loop resumes the execution
  → generator or evaluator advances
```

Local `ProgramRequest` values contain record capabilities (including an effect
attempt closure) or emission descriptors. They are not a transport format.
`ProgramReply` carries a record outcome or emission acknowledgement. The kernel
backend translates portable evaluator requests and value/throw replies into this
vocabulary; it no longer owns a driving loop.

The Effection kernel installs its effect runtime in a child resource and inherits
container capabilities. Ordinary functions passed to `openProgramAttachment`
also run through that kernel. There is no second direct-generator path.

## Lifetimes and recovery

- **Cancel** delivers logical cancellation into the program. Authored cleanup may
  suspend for another request.
- **Dispose** releases compute. Disposal does not dispatch cleanup requests to
  the host.
- **Terminal execution** remains available for snapshot capture until its owner
  disposes it. Completing a turn is not itself an instruction to destroy the
  evaluator.
- **Effection recovery** starts a fresh generator and replays authority-accepted
  outcomes. It offers no generator snapshot capability.
- **Snapshot-capable recovery** retains compatibility validation and scoped
  `KernelExecutor` restore middleware. The driver still wraps computation
  snapshots with protocol position and recovery identity.

`ProgramBackend` remains the preparation and checkpoint integration boundary:
manifest lookup, pinned code loading, snapshot validation, capture, and release.
`ProgramComputation.start()` returns a live execution and its first boundary.
Neither interface owns the request-driving loop anymore.

## Executable scenario

`packages/journal-authority/src/workflow/__tests__/effection-container.test.ts`
runs preparation, accepts it in the real in-memory journal authority, reserves a
question, and disposes the first container. A participant answers while no
container exists. A fresh container replays both outcomes and completes.

Assertions cover two generator starts in distinct scopes, both scopes released,
one effect attempt, and the same question identity after replay. Further tests
cover cancellation with suspended cleanup and rejection of foreign receipts.

The original experiment has been folded into the production attachment path;
its duplicate kernel and forwarding loop were removed.
