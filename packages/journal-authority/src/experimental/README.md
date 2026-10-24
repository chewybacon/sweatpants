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
planner parks that pull, and this runner refuses reactivation without dispatch.
Recovery of such unaccepted work remains unsupported; it is distinct from the
abandoned lease defect. Immediate successful reactivation is proved only when
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
guest finalizers. Handler interruption/unknown outcomes, competing writers,
lease renewal, power-loss durability, structured children, emissions, remote
placement and production reference crash recovery are not established. Fresh
process termination here is precisely after committed acceptance. Authority
validation and fencing remain active, but these tests do not independently prove
their entire contract. There is no exactly-once remote-effect claim.

A future migration, after extending conformance, could replace the orchestration
in workflow/driver-drive.ts, replay-walker.ts and advancement-drive.ts, and the
record-only runtime/ProgramDriver bridge. The existing program-recovery chain
and frontier validators remain reused here. Other drivers, transport protocols,
full effect/cancellation semantics, authority decisions, schemas and storage must
remain until separately covered. No production paths are deleted by this PoC.
