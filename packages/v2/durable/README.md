# Replay-first recovery

`createRecovery` builds a scoped API over a bound `GuestWork`. Its default recover
operation starts a fresh Guest, verifies each accepted request, and supplies its
recorded Outcome. Reconstruction never invokes a business handler. The result
contains the live Guest, its current Turn and the number of accepted outcomes
reflected in that Turn. The executing scope owns Guest disposal.

`createCheckpointMiddleware` is ordinary `OperationMiddleware` over that API.
For a compatible checkpoint it restores evaluator state and replays only the
accepted suffix. Missing/unsupported checkpoints delegate to the replay default.
Outer policy can remove the checkpoint from the plan to force full replay. Errors
from a supported restore propagate; corruption does not silently become replay.

Capture is optional. The default returns undefined; the middleware asks its
checkpoint adapter to capture a suspended Guest it owns. Completed Turns do not
need a checkpoint. Snapshots contain evaluator state, while the recovery envelope
binds it to a program identity, accepted position and receipt. Unknown Guest
implementations remain replay-capable without implementing capture or restore.

## Ownership and trust

Plans are supplied by a trusted host with immutable accepted history. Receipt
identities must uniquely identify immutable accepted entries; their authenticity
and contents are not established by this package. The program identity must pin
code, bound input and replay-relevant configuration. The request comparator is
owned by the host's domain protocol. Replay requires retained history and
reproducible computation between requests.

Validation checks contiguous sequences, distinct receipts, program identity and
checkpoint position/receipt. Each replayed request must match its accepted entry.
These are consistency checks, not authentication, journal admission or a substitute
for wire decoding. A host persists Outcomes before resuming the Guest and updates
the returned position/Turn after each newly accepted outcome. Capturing a stale
Recovered value is not a way to discover the Guest's actual journal position.

Scope finalizers dispose acquired/restored Guests after success or replay failure.
An evaluator owns cleanup during a failed/interrupted restore before it returns a
handle. Disposal must not run logical workflow cancellation.

## Evidence

The recovery acceptance journey uses the real pinned Lua/Wasm evaluator and a
scripted protocol peer. It accepts reservation and approval outcomes, retains an
earlier checkpoint, disposes the live Guest, and reconstructs a fresh Guest using
full replay or checkpoint plus suffix replay. Both paths reach the same cleanup
request and result. Command counts prove that restore skips the prefix, and peer
counts prove that reconstruction does not repeat accepted effects. A separate
case replays the same effect history into an ordinary TypeScript iterator.

The application exercises Around on acquisition, OperationMiddleware on recovery,
and the Middleware value-signature shorthand on domain requests. Both native
runtimes run the same application. Unsupported/disabled checkpoints fall back;
corrupt snapshots, wrong anchors/programs, invalid history and divergent requests
fail. Source/emitted type checks retain the decoded result type through recovery.

Only detached in-process history and snapshots survive between activations. This
is not yet a persistent journal implementation, OS-process crash test, deployment,
exactly-once external-effect guarantee, or durable logical cancellation protocol.
