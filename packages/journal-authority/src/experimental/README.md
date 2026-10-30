# Sequential journal experiment

`sequential-journal.ts` is opt-in research code, with no package export or host
installation. It owns the synchronous guest, advancement, reconstruction,
reservation, handler dispatch, acceptance and completion. It never constructs a
ProgramDriver or calls the production activation/recovery/advancement loops.
Effection owns asynchronous host operations. The existing authority owns schema
validation, receipts, fencing, leases and persistence; SQLite is unchanged.

Run from the repository root:

```sh
pnpm --filter @sweatpants/acceptance test __tests__/journal-primitives/sequence.acceptance.test.ts
pnpm land
```

The acceptance worker supplies a fresh synchronous generator and a typed handler.
Two identical repeatable record descriptors receive distinct external answers.
The driver checks the full replay chain and expected head, checks each request
against its accepted entry, then advances with its persisted outcome. Each live
acceptance discards the current guest and reconstructs from a fresh authority
plan. This deliberately trades warm continuation efficiency for one delivery
path. External effects belong only in the handler; ordinary guest code reruns.

Four comparisons cover uninterrupted operation, exit after acceptance 0, exit
after acceptance 1, and successive exits after both. Exit code 73 occurs after
SQLite commit and before guest delivery. Every resume is a fresh OS process,
SQLite handle, authority resource and guest. A separate process reads each
interrupted prefix. The external JSONL ledger proves call count/order; guest
traces show the interrupted outcome has not been delivered. Completed reactivation
returns the authority terminal result, as the production activation driver does;
it does **not** reconstruct or revalidate a completed guest. Both engines must
leave completed journal records and external counts unchanged.

The independent reference is the actual current WorkflowProgramDriver and
`driveProgramDriverActivation` in this checkout. Workload payloads compare exactly:
TaskOpened, PullRequested, AttemptStarted, PullResolved, TaskClosed, including
occurrence IDs, indexes, digests, program/input and outcomes. Only journal envelope
metadata and AdvancementBound/AdvancementReleased are omitted. Lease attachment
identities and frontier proofs differ between implementations. Unknown event
kinds fail comparison. SQLite databases, raw records, interrupted prefixes, worker
logs and per-case passing reports remain in ignored `.artifacts/journal-primitives/`.

Bound activation errors attempt the existing fenced `execution.release-mandate`
with reason `failed`, preserving the original error even if cleanup fails. The
release contract checks owner, epoch and attachment; stale cleanup cannot release
a replacement owner. Successful settlement/completion already ends the lease,
so the runner does not release again on that path. This is error cleanup, not
cancellation/finalizer or retry orchestration.

Additional acceptance cases cover failure before reservation and immediate
reactivation at the same fixed clock, handler failure with fenced lease release,
cleanup failure preserving the original error, invalid
resolution capability, and actual SQLite rollback at `execution-before-commit`.
The fault connection opens only at resolution, after reservation and the external
call. Independent reopening proves no accepted outcome or terminal; guest traces
prove no delivery and the ledger proves no second dispatch. Once reservation has
created an open pull, release alone does not make it replayable: the production
planner parks that pull. With the default `recoverPending: false`, this runner
refuses reactivation without dispatch. The explicit recovery option below handles
that state; release alone still does not grant permission. Immediate successful reactivation is proved only when
no unaccepted pull remains (pre-reservation failure or rejected completion).
Query corruption covers truncated, reordered, duplicated and digest-invalid
accepted history; changed program/input and extra history after guest completion
also fail before binding. Existing divergent-request/unsafe checks remain.
Real competing binds, mandate expiry at reserve/complete, and replacement before
reserve exercise authority fencing. Stale cleanup leaves the new owner's lease
intact. These controlled local transitions are not a concurrent-writer test.

Bounds: successful sequential repeatable records in a local single strand only.
Non-record/unsafe requests, failed outcomes, cancellation, continuation checkpoints,
non-replayable placement and rejected authority commands fail explicitly. Guest
exceptions propagate; this prototype does not persist failure terminals or run
guest finalizers. Competing writers, lease renewal, power-loss durability,
structured children, emissions, remote placement and production reference crash
recovery are not established. The original comparisons terminate after committed
acceptance; the pass-2 fixtures below also terminate before acceptance. Authority
validation and fencing remain active, but these tests do not independently prove
their entire contract. There is no exactly-once remote-effect claim.

A future migration, after extending conformance, could replace the orchestration
in workflow/driver-drive.ts, replay-walker.ts and advancement-drive.ts, and the
record-only runtime/ProgramDriver bridge. The existing program-recovery chain
and frontier validators remain reused here. Other drivers, transport protocols,
full effect/cancellation semantics, authority decisions, schemas and storage must
remain until separately covered. No production paths are deleted by this PoC.

## Pass 1: explicit recovery permission

`execution.recover-record` is an opt-in authority command. It accepts a current
program capability and the exact session/task/turn, action index, pull index,
pull ID, latest attempt ID and proposed descriptor. `replacement` is a
`BindMandateRequest`: new nonempty attachment/owner, a 1–300000 ms lease, exact
program/address/epoch/head/group expectations, a trusted-host frontier proof and
local program placement. Checkpoints are refused. The attachment must change.
The authority checks the accepted head and replayed-through index; the host must
validate the replay chain and guest frontier before submitting the proof. The
proof is a host assertion, not cryptographic evidence of guest execution. It requires one active root
strand with no cancellation, fork group or continuation checkpoint. Neither a
live task mandate nor a live session activation owner may be displaced. The
existing program capability verification fences journal incarnation, audience,
program identity, attachment and execution epoch. A caller must obtain current
attachment authority through the existing host protocol; knowing IDs is not
permission. Expiry alone does not authenticate a caller.

The target must be the open, unrevoked frontier pull and its persisted descriptor
must be a repeatable record identical to the request. Accepted occurrences,
stale attempts, unsafe records and descriptor changes are refused. In one normal
authority/storage transaction it revokes all prior attempts using
`AttemptAbandoned(reason=repeatable_record_recovery)`, increments the execution
epoch, installs the replacement attachment and task lease using the ordinary
mandate installation machinery, emits `AdvancementBound`, and emits
`AttemptStarted` for the next attempt index. An expired lease is overwritten,
just as in ordinary binding; there is no release event for a transaction whose
final state has a replacement lease. The
returned authorization contains the same pull ID and a new attempt ID and
resolution capability plus `mandate`, including fresh program authority and a
fenced cleanup receipt. Old program capabilities cannot call reserve-pull to
retrieve the new resolution token or recover again. Even the new program
capability cannot recover while its task lease is live. Release only the returned
mandate with `execution.release-mandate`; stale cleanup leaves a successor's
lease intact. Successful resolution ends its lease normally. The former resolution capability is rejected as `capability_revoked`,
even after reopening SQLite. No new PullRequested or accepted outcome is created.
Only subsequent ordinary resolution can advance accepted history.

There is no persistence schema change: existing attempt rows and semantic records
represent lineage. The command/result union is additive. Existing abandon,
reserve, restore tickets and resolution semantics are unchanged. Abandon followed
by reserve could revoke and start attempts, but those separate commands do not
atomically enforce this safety/identity/ownership policy; ordinary reserve also
can return an existing authorization. Restore tickets authenticate reconstruction
and do not themselves authorize replacement of an unknown attempt.

This command deliberately leaves the row `structurally_blocked` until resolution.
The default production loop never calls it. The experimental loop calls it only
when explicitly enabled as described below. A lost permission response requires
fresh observation and waiting for lease expiry (or authorized release); retrying the original expected attempt is rejected. This is
repeatable external work, not exactly-once effects or a general retry scheduler.
Recovery can repeat a remote call whose earlier answer was never accepted.

Acceptance:

```sh
pnpm --filter @sweatpants/acceptance test __tests__/journal-primitives/recovery-permission.acceptance.test.ts
```

These authority checks use real file SQLite and resource reopening in one process;
process-loss loop integration is covered separately below. They cover lineage, late revoked
settlement, accepted-history provenance, live session/task owners, expired task
lease, stale attachment/attempt, invalid capability, changed occurrence/descriptor,
unsafe/idempotent/non-record safety and cancellation. They also cover old program
authority rejection, multiple detached contenders (including equal late results
after acceptance/reopening), stale cleanup, repeated recovery after release,
second-identical-occurrence discrimination and a real SQLite pre-commit rollback
with an exact comparison of every stored table. They do not claim distributed
writer or storage owner-fence fault coverage. Supported placement is a trusted
host's declared local program placement on a single root; this command does not
attest where the host physically runs or reinterpret opaque persisted routes.

### Resolution-token boundary

`pull.resolution-capability` rejects attempt-owned pulls (records and effects)
with `invalid_resolution_capability`, before and after recovery or acceptance.
It cannot authenticate an owner from session/task/pull IDs and does not expose
successor attempt authority. Current program owners retrieve that authority via
`execution.reserve-pull` with current program capability and the stored occurrence
indices; recovery returns the new attempt authority atomically. Ordinary mandate
reservation still uses the next pull cursor and is not an open-pull retrieval API.
The shared signer also refuses to mint an attemptless token for an attempt-owned
pull. Resolution rejects already-issued legacy `attemptId: "none"` tokens for
those pulls before duplicate handling or any cursor/outcome/lease mutation.
This deliberately tightens legacy record/effect query semantics globally, without
storage or token-schema changes. Ordinary valid detached attempt contenders keep
their accepted/equal-duplicate/changed-conflict policy; explicit recovery still
revokes all older attempts. Non-attempt external elicitation tokens remain valid
across attachment replacement, subject to their existing revocation rules.

## Pass 2: explicit host recovery in the iterator

Pass `recoverPending: true` to `driveSequentialJournal` on a trusted local host.
The default remains refusal of pending work; the original 21 sequence cases and
ordinary no-pending path remain intact. No production driver enables recovery.
The option is a host policy choice, not permission granted to guest code.

`task.record-recovery-observation` is a narrow read-only query for one active,
uncancelled root with an unresolved attempted pull and no fork group or checkpoint.
It uses the existing replay-item builder to return the accepted prefix even when
the ordinary planner correctly reports `structurally_blocked`. It also returns
current attachment identity and the exact stored pending action/pull indexes,
pull ID, latest attempt ID and descriptor. It returns no capability, lease or
runnable classification. Observation does not assert that a lease has expired or
that retry is safe. The atomic recovery command still decides those questions.
Existing public recovery/input/pull queries do not expose this prefix and generation.

Before requesting any permission, the runner compares observed address, strand,
head, group context, program, input and route with its normal plan and attachment.
It validates the identity-bound chain seed, every chain link, exact accepted head,
sequential successful records and each guest request. The pending guest operation
must exactly match the stored descriptor and action index. Unsupported driver or
affinity, multiple roots, cancellation, checkpoints, unsafe/other records and
failed accepted outcomes are refused. Opaque program route data must equal the
host attachment route; it is not a physical-locality attestation.

The runner has unrestricted trusted-host `JournalAuthorityContract` access. It
calls existing administrative `execution.bind-attachment` with the observation's
**current** attachment and epoch to obtain current program authority, then calls
`execution.recover-record`. This is not a worker-facing service: do not expose
administrative commands or this runner to holders of old program capabilities.
The bind does not intentionally replace attachment or detach attempts; its existing
side effect clears the session runnable hint. Recovery itself rotates attachment
and epoch. A stale worker capability still cannot retrieve the successor. This
path relies on the existing host administration trust boundary, not on IDs as
worker authentication. It adds no new capability issuance query and changes no
pass-1 decision guards. Concurrent administrative attachment rebinding is outside
this sequential host experiment.

Only the committed recovery response supplies the mandate and reservation used
together for dispatch. There is no second ordinary mandate-reserve call for an
open pull and no cursor rewind. Failure cleanup uses that exact returned mandate;
normal successful resolution ends the lease. The handler answer is never delivered
to the guest directly: the loop reconstructs from the next accepted replay view.
Terminal reactivation still returns the stored successful terminal value without
reexecuting the guest. A lost permission response leaves a live lease and unknown
attempt; a later host must observe again after actual expiry or legitimate release.
There is no waiting loop, scheduler, renewal or automatic permission retry here.

Fresh-process acceptance (`recovery-process.acceptance.test.ts`) covers external
completion followed by exit 74 before resolution, a refused restart at the same
persisted fixture clock, and restart after the authority's 30-second lease expires.
The first accepted identical occurrence stays unchanged; the second retains its
original indexes/pull ID, gets one successor attempt and supplies the final accepted
answer. A separate case exits 75 after recovery commit before dispatch and recovers
after the replacement lease expires. Handler failure followed by fenced release
permits another recovery at the same clock. Stored unsafe work, bad parked replay,
identity changes, unsupported placement and multiple roots cannot dispatch.
SQLite snapshots, process exit/stderr logs, external-call ledgers and guest PID
traces are retained under `.artifacts/journal-primitives/recovery-process-*`.

This establishes repeatable work after these two process-loss boundaries, not
exactly-once external effects or cancellation of old workers. Pass 3 adds the repeated-loss and retained-capability evidence below. Host trust, single sequential writer and successful record-only semantics
remain explicit limitations. Replay still reconstructs the complete prefix per
accepted step (quadratic total replay work for a long sequence); recovery adds one
observation plus administrative bind and atomic recovery, without importing a
second production advancement/replay loop.

## Pass 3: repeated losses and retained authority

The real process harness now loses two external results at **each** identical
occurrence, interleaving a committed recovery-permission loss at the first. Seven
attempts produce six external calls: first-occurrence generations 0–3 and
second-occurrence generations 0–2. The permission-only generation never dispatches.
The accepted answers are calls 3 and 6, and only those answers reach the guest.
Exact pull IDs, action/pull indexes, attempt IDs, abandonment order, dispatch order,
accepted prefix and terminal restart are checked through separate-process readback.
Each restart uses actual persisted authority lease expiry; no synthetic attempt
state substitutes for the interrupted workers.

Old program, named resolution and signed legacy attemptless capabilities are
retained on disk before takeover and injected through public APIs in new processes
both while a replacement is live and after acceptance. Equal and changed late
answers reject with exact codes; old program reservation and stale mandate release
also fail. Every probe compares **all SQLite tables** after each call, including
private state and the replacement lease. The legacy fixture uses the host signing
primitive with the historical `attemptId: "none"` shape; it is not newly issued
by the restricted resolution-capability query. The earlier permission suite also
retains its actual pre-fix query token fixture.

A deterministic interleaving accepts the old settlement immediately before the
recovery command: recovery rejects the stale occurrence, leaves the winner's full
stored state intact, and dispatches nothing. A later normal activation replays that
winner and executes only the second occurrence. This is ordered local evidence,
not a simultaneous-writer guarantee.

Genuinely persisted unsafe pending work survives repeated restart attempts with
unchanged tables/history and no permission, call or outcome delivery. Corrupted
replay/identity/frontier inputs require their exact diagnostic codes and messages,
not merely exit 1. Rejection fixtures reuse closed real database copies; their
semantic readback reopens a separate authority resource locally to avoid redundant
interpreter startup. Positive process-loss cases retain separate readback processes.

No production algorithm change was needed for these challenges. All prior 67
journal cases remain, with five additional process cases (72 total). This adds
acceptance evidence, not a scheduler or a second runtime abstraction. Full-prefix
reconstruction remains quadratic across a long run. Trusted local administration,
single sequential writer, successful repeatable records and all preceding limits
remain unchanged; cancellation, distributed scheduling, physical old-worker
termination, power-loss durability and exactly-once external effects are unproved.
