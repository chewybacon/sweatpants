# Executor recovery through scoped middleware

This isolated experiment composes the existing real Hoot fixture, shared program
driver, recovery policy, and executor transport spike. No production entry point
or universal executor interface changes.

```text
Principal: Executor.start(program selection + trusted recovery plan, input)
  → local queue or worker messages (serialized commands/envelopes)
    → operative scope
      → Executor.start middleware
        → recoverProgram: mandatory plan validation
          → ProgramRecovery observation and policy
            → checkpoint acceleration, or full replay
              → ProgramPeer → shared driver → kernel backend → Hoot
        → mandatory recovered-position validation
      → Execution handle stays inside operative
      → ProgramRecovery.checkpoint after each returned boundary
    ← boundary + optional checkpoint metadata
```

The principal sees the same `start / resume / cancel / dispose` API. Checkpoint
metadata travels in the response envelope; it is not an authored tool request.
The principal would persist and bind it to accepted journal history. This test
manufactures accepted receipts and plans, so it does not prove authority admission,
authentication, fencing, or durable storage.

Restoration starts a fresh connection with a trusted recovery plan. Scoped
`Executor.start` middleware selects recovery, while the existing `ProgramRecovery`
middleware chooses snapshot acceleration or replay. This is an experiment-specific
program selection shape, not a new public start signature.

## Scope ownership matters

A context facade dispatches in the calling scope; obtaining one in a resource
does not retain that resource's middleware. Local transport therefore queues
commands to a task owned by the operative scope. Worker transport does likewise
inside the worker. No foreign scope binding or live execution handle crosses the
boundary. Closing the connection releases its compute; resource teardown also
cleans up startup failures.

The kernel now returns the shared execution handle directly, including capture.
The backend's forwarding executor and handle lookup have been removed. Recovery
policy still composes above evaluator-owned capture and restore mechanics.

## Evidence

For both local and worker placement:

- Capture after reserving a hold; accept approval; destroy the first connection.
- Restore the earlier checkpoint in a fresh connection and replay exactly one
  accepted reply to reach pending cleanup.
- Disable acceleration with outer middleware; full replay reaches the same
  boundary, using two accepted replies instead.
- Answer cleanup and complete with `Caller received: approved`.
- Two live connections retain independent recovery policies.
- Invalid history and corrupt supported snapshots reject across transport.

The test checks Hoot start/restore/resume events, not just equal final output.
The existing recovery-middleware test additionally checks policy ordering,
pre-dispatch validation, unsupported formats, restoration cancellation, and
rejection cleanup.

## Run

### Durable host scenario

`__tests__/host.mjs` uses the stored journal authority and the production tree and
activation drivers through their test-host composition. It opens the task, accepts
replies using real resolution capabilities, and replaces the host scope, authority
shell, and Hoot compute at every park. Only the memory execution store survives.

The scenario explicitly follows reservation → approval → cleanup → completion.
It asserts journal-owned continuation checkpoints, middleware observation on all
four activations, one original start followed by three restores, compute disposal
at every park, and exactly three unique journal pulls. Unlike the transport test,
it does not manufacture receipts or recovery plans. It does not cover OS-process
crashes, disk durability, HTTP, or a deployed application.

A second scenario installs scoped replay-only policy and repeats the same work
with four fresh evaluators. It asserts the exact replay events, absence of stored
continuation checkpoints, and equality of journal request descriptors and final
output with the snapshot scenario. The authority stores continuation payloads;
the recovery API's replay marker does not itself become a stored checkpoint.

```sh
NODE_OPTIONS=--conditions=development node --import tsx experiments/workflow-kernel/executor-recovery/__tests__/host.mjs
```

Requires the built workspace packages and current Hoot composition artifact,
as does the existing Hoot experiment. Node 24, from the repository root:

```sh
NODE_OPTIONS=--conditions=development node --import tsx experiments/workflow-kernel/executor-recovery/__tests__/recovery.mjs
NODE_OPTIONS=--conditions=development node --import tsx experiments/workflow-kernel/recovery-middleware/__tests__/recovery.mjs
```

Runs worker connections sequentially except for the explicitly two-live-connection
isolation scenario. No application deployment is involved. `pnpm test:execution-recovery` runs all
three recovery scenarios sequentially; the deterministic `pnpm land` gate now
includes that command after the clean build.
