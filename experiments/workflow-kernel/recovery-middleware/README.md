# Scoped recovery middleware integration

The production recovery policy lives in
`packages/durable-execution/src/program-recovery-policy.ts`. This experiment
exercises that implementation against real Hoot execution through `ProgramPeer`.
It does not add routing or replace a driver.

```text
Authority recovery plan (full accepted history + optional checkpoint)
  → mandatory history and checkpoint-anchor checks
  → ProgramRecovery API
      → observation / deployment policy (max)
      → backend checkpoint accelerator (min)
      → default full replay
  → existing ProgramPeer / driver registry
  → backend execution
  → mandatory returned-position check
```

## Findings

- Replay is a working default for both checkpoint capture and recovery.
- Middleware can delegate before acquiring compute or consuming history.
- A supported checkpoint selects restoration with only the accepted suffix.
- Unsupported formats fall back to full replay in this experiment. This is an
  explicit policy, not permission to swallow restore errors.
- Outer policy can disable acceleration regardless of installation order.
- Installation is inherited by descendants and isolated between sibling scopes.
- The real experimental Hoot driver reaches the same frontier using full replay
  or snapshot restoration plus suffix replay.
- Cancellation during an asynchronous restoration unwinds backend-owned cleanup.
  This uses a controlled backend to create the suspension, not a claim about
  interrupting synchronous Wasm instructions.
- Invalid history/anchors fail before middleware dispatch. A supported but corrupt
  backend snapshot fails without fallback. Invalid returned positions release
  the returned attachment.

The authority must supply the plan. Consistent hashes alone do not authenticate
history or establish permission to restore it. Middleware is trusted host code.

## Integration boundary

Production `replayStrand` passes the complete plan to `recoverProgram`, which
validates history and checkpoint anchors before dispatching recovery policy.
`driveProgramDriverActivation` installs acceleration in its activation scope when
the selected driver declares a continuation format. `bindCaughtUpLeaf` captures
through the same API. Drivers without that capability use replay by default.
Outer middleware can disable acceleration without changing the backend.

The spike's duplicate recovery implementation was removed. Package unit tests
cover the policy contract in the regular landing gate; this experiment additionally
checks real Hoot checkpoint and suffix restoration.

This uses the shared program driver with the experimental Hoot kernel backend.
The former parallel Hoot driver is removed. The backend reconstructs its saved
boundary inside a fresh shared attachment; the driver restores protocol position.

Suggested vocabulary (not additional packages yet):

- **Program backend:** advances computation; Effection generator or Scheme machine.
- **Program driver:** exposes execution through the existing program protocol.
- **Recovery policy:** chooses replay or supported checkpoint acceleration.
- **Authority:** owns accepted history and checkpoint provenance.

## Run

Requires built workspace packages and the Hoot composition artifact. On Node 24:

```sh
node experiments/workflow-kernel/recovery-middleware/__tests__/recovery.mjs
```

Tests use manufactured receipts as recovery fixtures, not an authority admission
proof. Existing Hoot authority tests cover journal checkpoint acceptance separately.
No application deployment or package hierarchy is changed by this integration.
