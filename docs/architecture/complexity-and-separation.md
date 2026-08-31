# Where the Complexity Comes From

> **Design-authority notice:** The approved [durable execution spine design](../../../.pi/specs/durable-execution-spine-design.md) is normative for Venue, Step, attribution, replay, peer strands, Mandate, R7′, and the `ephemeral` rename. This document is retained as historical analysis and does not define a competing current shape.

**Status:** Jam notes — working analysis, not yet decided policy.
**Companion:** [vocabulary.md](./vocabulary.md) · [responsibility-map.md](./responsibility-map.md)

## Ledger

**Ratified:** R1′–R6′ (see Forest Discipline below) · replay/live-edge
separation finding · peer-hosted delivery contract.
**Proposed:** R7′ structure-vs-order (end of this section) · zero-trust
cold-start snapshots. Type-level synthesis (α interpreter core / γ ledger /
β supervision) lives in [spine-types.md](./spine-types.md) §0.

## The compression

Sixty-four glossary terms reduce to one sentence:

> **The machine is a fenced protocol for leasing journal positions and
> filling them with evidence.**

Reserve mints a slot-lease (pullId + attemptId + resolutionCapability). Work
happens anywhere. Commit fills the slot with receipt-backed outcome. Replay
trusts filled slots. Settlement completes a slot whose lessee died. Drives,
transports, evaluators, projections propose, finish, or read.

Triage rule for every future argument: *is this about leasing/proving slots,
or about what goes in them?* Only the former may grow the kernel.

## The four roots

| Root | Premise | Words it owns | Count |
|---|---|---|---|
| ① irreversible × mortal | effects undo nothing; executors die | lease, fence, epoch, frontier, restore, receipt, recovery, disposition | ~8 |
| ② world answers slowly | hours-long waits outlive executors | park, settlement, onPark, participant, pending, elicit/wait | ~6 |
| ③ replay over rerun | history is recovery | descriptor-verbatim, manifest, digest, snapshot, canonical, record, transition | ~8 |
| ④ execution far from truth | chosen deployment | transport, evaluator, driver, protocol, bridge | ~7 |

Two-thirds of the vocabulary serves ①–③, which compress to: *the world is
irreversible, and both it and our executors are unreliable and slow.* That is
the product premise, not overhead. ④ is voluntary spend buying isolation and
scale. Accidental complexity (identity clumps, route parsing ×3, dual-mode
sampling, god-file projection) owns zero words — scheduled for removal.

Lineage worth borrowing confidence from: epoch ≈ fencing token; lease ≈
fenced single-writer; frontier ≈ acked log position; receipt ≈ commit ack;
replay ≈ deterministic replication; verbatim descriptors ≈ intent logging.
Park/settlement = two-phase commit whose coordinator always dies, completed
by delegated capability. Cancellation = abort reconciling detached attempts.

Boundary line to hold: queries answer questions about slots; they must not
become a second API for controlling them.

## Open decision hiding in an omission

Nothing ages. A participant may answer in nine months. Do we want slot
expiry — reservations that die unanswered, tasks that fail by abandonment?
Currently an unmade decision, not a made one.

---

# Replay-to-Frontier vs Advancing the Log

## Finding: the phases are mixed in today's code

Five pieces of evidence:

1. `host-drive` catches up per-record *inside* the live pump — reservation
   returns `"resolved"`, the interaction loop resumes with `replayed: true`.
2. Two replay mechanisms coexist: local per-record inline vs remote bulk
   prepare-restore → divergence check → bind-frontier. Chosen by transport,
   not by concept.
3. Type-level scars: `replayed` flags on commands/receipts;
   `restoredFrontierConsumed` telling the loop which mechanism fed it;
   `pullIndex` initialized differently per path.
4. Cancellation guards (`shouldInjectBeforeStep`) exist partly because
   cancellation can arrive mid-history — meaningless under separation.
5. Local reattachment is O(n) single exchanges; no bulk path on that side.

## The separated shape

```
mandate issued → attachment binds:
  REPLAY PHASE — walk records · feed outcomes · zero authority writes ·
                 no venues fire · ends at frontier bound (proof attached)
LIVE EDGE — only past frontier==head:
  reservations answer authorized|pending only; venues gate; capabilities
  spent; receipts returned; parks happen; onPark adjudicates reissue
```

Invariant: **the drive never learns there was a past.**

## What dissolves under separation

`replayed` flags; `restoredFrontierConsumed`; dual replay mechanisms; divergent
index initialization; cancellation-during-history guards; O(n) local reattach
(bulk streaming via existing segmentation). Catch-up becomes property-testable
with no interaction mocks: feed records, assert frontier.

Cost noted honestly: bulk catch-up pages large journals — segmentation gains
its true first client.

## Naming gap

Glossary holds *replay* (action) and *frontier* (position) but no word for
the phase boundary where catch-up hands off to live work. Candidates: live
edge, seam, head. Undecided.

---

# Forest Discipline — ratified direction (jam, v2 rules)

Born from the two-parked-elicits scenario: root spawned a detached sub-agent,
both parked on elicits, one inbound message. The pathology was never multiple
heads — it was heads escaping the fork that created them.

## Ratified rules

> **R1′ Ancestor freeze** — at most one open fork group per task; ancestors
> freeze until their subtree settles. Suspension point = fork point.
> **R2′ Lifetime-awaited forks** — forks may ignore values, never lifetimes;
> spawn-as-detachment is retired pending a real use case.
> **R3′ Recursive roots** — peers run as roots under the same rules;
> advancement is depth-first through fork groups.
> **R4′ Bounded surfacing** — projections surface open slots of the current
> fork group only, with attribution chains.
> **R5′ Group expiry** — every fork group carries expiry policy; unwinding
> cancels outstanding members. Stack hangs are structural failures.
> **R6′ One child protocol** — children differ in one property: whether the
> host strand owns their continuation state (`durability`: `crank_native` |
> `peer_hosted`), plus a placement route. All delegated interaction, in both
> directions, occurs as strand records under the standard reservation,
> venue, and receipt grammar; black-box peers receive deliveries and never
> touch the journal. **Delegation is a MAY**, never implied: undelegated
> interactions (e.g. a peer's private model sampling) remain the peer's own
> state and appear in the strand only as deliveries and declared evidence.
> Delegated samples are journaled and host-metered; undelegated are
> peer-metered and invisible to history.
>
> **R7′ Structure vs order — PROPOSED, not ratified.** The kernel owns
> concurrency *structure*: forest rows, slot lifecycle, terminal algebra
> (including `expired`), structural refusals such as detached-origin slots.
> Hosts own *order*: which leaf, which transport, which moment. Structural
> rules are kernel-enforced; ordering rules are host policy; neither layer
> reaches into the other.

Compute concurrency inside a group is unrestricted; only slots are exclusive.
Effection's scoped `spawn` already embodies R2′ — the substrate agrees with
the journal layer's discipline for the first time. Effection scopes are the
process-local shadow of strands/forest: faithful during life, forgotten at
death; strands persist to be re-shadowed.

## Notify/log ruling

Journal when ordering or exactly-once matters to history (attempt-venue
effect). Keep ephemeral when purely diagnostic. No unjournaled notify that
anything later depends on — that is spawn returning through the back door.

## What dissolved vs survived

Dissolved: orphan/widow policies; forest-wide routing ambiguity; merge-back
designs A/B/C (merge happens at the fork by construction); singular
`activeExecutionId` chaos (becomes bounded fork-group leaf set).
Survived, transformed: multi-slot routing (bounded to live group, needs
attribution chains); slot expiry (attaches to fork groups — R5′); replay
plan (one strand per activation; the group defines which strands are live).
Retired: spawn pending a real detached-lifetime use case.

## Peer-hosted children (R6′ consequences)

Delivery contract: journal-first, then deliver with correlator;
at-least-once toward the peer; peers SHOULD be idempotent per correlator.
Replay covers our strand only — the peer side of history is absent from it
by construction, so replaying them is a no-op by type. Peer death surfaces
as an errored outcome (ephemeral_reference_lost class), journaled, and the
authored program moves on. Park rent during long waits is commercial, not
correctness. Evidence discipline: anything a peer exports enters the strand
as opaque, attributed evidence — observations from foreign authorities are
never reconstruction recipe.
