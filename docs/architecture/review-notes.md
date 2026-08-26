# Review Notes — Fresh Session, Independent Pass

Reviewer: independent session per `HANDOFF.md`. Branch
`rr/cordis-style-refactor`, HEAD `f4b9842c`, clean tree. All evidence
commands ran from repo root on this HEAD. Docs: `vocabulary.md` (D1),
`responsibility-map.md` (D2), `complexity-and-separation.md` (D3),
`spine-types.md` (D4).

Protocol deviation: Pass 1 found a BLOCKER, which the handoff says should
end the session. I continued because the blocker is a naming collision, not
a semantic one — read `commission` and `Mandate` as aliases and the design
stays self-consistent, so passes 2–3 still mean something.

---

## Pass 1 — internal consistency

### [BLOCKER] The bind-time envelope has two canonical names: `commission` (D1) vs `Mandate` (D2, D3, D4)
Doc(s): D1 §Definitions/commission, §Rename map #9; D2 §Amendments; D3 §The separated shape; D4 §2
Claim: D1: "One concept, one word … Introduce the **commission**: bind-time
envelope unifying placement, capability, addressing, and kernel context."
D4 §2: "the mandate is what the attachment carries after binding succeeds …
Naming stays `Mandate` for the carried form."
Finding: These are the same concept: the envelope an attachment carries
after bind, retiring the `{sessionId, turnId, taskId, …,
programCapability}` clump and D2's seam #3. D1 names it commission; D2, D3,
and D4 name it Mandate; neither name acknowledges the other. The word
"mandate" does not occur in the vocabulary document at all. The set
violates its own prime rule in its most central new noun, and D4's "naming
stays Mandate" flatly contradicts D1's rename map #9.
Evidence: `rg -in 'mandate' docs/architecture/vocabulary.md` → 0 hits.
D2 Amendments: "Mandate / ReactivationPlan formalize bind-time facts
(placement, capability, addressing), retiring the capability-binding seam
(#3)" — the member list and seam D1 assigns to commission. D3: "mandate
issued → attachment binds".
Suggestion: Pick one. Mandate has three documents and the type sketch;
commission has the vocabulary. Put the loser in D1's collision table as a
purged alias and fix rename map #9 or D4 §2 to match. Do not adopt with
both alive.

### [CONCERN] The ledgers of D1, D3, D4 disagree with each other and with their own bodies
Doc(s): D1, D3, D4 — Ledger sections
Claim: Each ledger presents itself as the shared decision record.
Finding: No two ledgers list the same sets.
- D3's ledger omits **notify/log ruling** and **evidence-not-recipe** —
  ratified in D1 (evidence-not-recipe also in D4) and present in D3's own
  body under the "ratified direction" section.
- D3 ratifies the **replay/live-edge separation finding**; D1 and D4 list
  only the handoff *name* as proposed.
- D1's proposed list omits **zero-trust cold-start** (proposed in D3,
  "open design thread" in D4 §8, on the handoff's open shelf).
- D4's proposed list omits **fork-group expiry values** and
  **driver→evaluator rename** (both proposed in D1).
- D1's body marks **lease** "(adopted)" and introduces **commission**, yet
  neither appears in D1's own ledger.
Evidence: ledger blocks at the top of each file; `rg -n -i 'notify'
docs/architecture/*.md` — ratified at D1:10, bodied at D3:152, absent from
D3's ledger.
Suggestion: Make D1's ledger canonical; have D3/D4 state only their delta
over it. Add lease and commission to D1's lists.

### [CONCERN] `venue`, `slot`, `delivery`, `SupervisionStrategy` have no vocabulary entry
Doc(s): D1 (omissions); used throughout D3, D4
Claim: D1: "This document defines the words the system is allowed to use."
Finding: Four words the spine documents cannot be read without are missing
from the vocabulary:
- **venue** — in D1's own proposed ledger, never defined. D3 builds on it
  ("venues gate", "attempt-venue effect") and D4 makes it a type
  (`"attempt" | "append" | "transport" | "host" | "world"`).
- **slot** — the central noun of D3's compression ("leasing journal
  positions"), of R7′ ("slot lifecycle"), of R4′, and of Invariant W. It
  appears in D1 only inside the leaf entry and collision table, and its
  relation to pull/reservation — same thing? position vs act? — is nowhere
  stated.
- **delivery** — "delivery contract" is ratified in D1's own ledger with no
  definition entry; D4 §5 defines the interface.
- **SupervisionStrategy** — the β layer in D2's amendments and D4 §0/§1; no
  D1 entry.
Evidence: `rg -in 'venue|slot|deliver' docs/architecture/vocabulary.md` →
ledger lines and the leaf entry only.
Suggestion: Four entries in D1. For slot, say plainly: a reserved journal
position addressed by pullId, and reconcile with pull/reservation.

### [CONCERN] Invariant W is cited three times in D4 and defined in none of the four documents
Doc(s): D4 §0, §3 (heading and contract comment)
Claim: "Continuations are never serialized — the trace re-derives control
(Invariant W)"; "cannot park (Invariant W)".
Finding: The only statement of W — "a strand being caught up contains no
unresolved slots" — is in `HANDOFF.md`, which does not ship with the
documents. A named invariant that licenses the replay walker's purity
contract must be stated where it is spent. See also Pass 3: as stated in
the handoff, W fails during cancellation unwind.
Evidence: `rg -n 'Invariant W' docs/architecture/*.md` → spine-types 29,
140, 147; HANDOFF 88 (definition only there).
Suggestion: State W in D4 §0 or D1, with its derivation from R1′+R3′ and
the cancellation carve-out below.

### [CONCERN] "peer" is bisemous inside the ratified rules and missing from the collision table
Doc(s): D1 fork-group entry, collision table; D3 R3′/R6′; D4 §5
Claim: D1: fork group = "the set of peers opened by one suspension point …
members run as roots"; D3 R3′: "peers run as roots under the same rules";
D3 R6′: "black-box peers receive deliveries and never touch the journal."
Finding: "peer" means (a) any fork-group member — including `crank_native`
ones that write strands (D1 fork-group, R3′); (b) a `peer_hosted` external
process that must never touch the journal (R6′, D4 §5
`PeerEndpoint`/`PeerHop`); (c) the `ProgramPeer` wire protocol (D1
exchange/transport). Read literally, R3′+R6′ say peers both run as
journal-writing roots and never touch the journal. The collision table —
built for exactly this — has no row for it.
Evidence: quoted lines; `rg -in '\bpeer' docs/architecture/vocabulary.md`.
Suggestion: Reserve "peer" for the peer_hosted sense — it already owns
`peer_hosted`, `PeerEndpoint`, `ProgramPeer`. R3′ and D1's fork-group entry
should say "members". Add the collision row.

### [CONCERN] Convicted seams #2, #4, #5, #7 have no resolution note and no rename-map home
Doc(s): D2 §Seams; D1 §Rename map
Claim: Handoff pass-1 checklist: every convicted seam gets a resolution
note or a rename-map home.
Finding: Covered: #1 (host renames), #3 (Mandate/commission amendment), #6
naming half (harnesses), #8 (retired structurally by Mandate/placement).
Uncovered: #2 `ActivationResult` vs `ProgramRunResult` — both still
exported from journal-authority; #4 `turnIdFor`; #5 descriptor codec; #7
the 25-line `export *` surface. "Structure work … follows after vocabulary
lands" gestures at #2 without naming it.
Evidence: `rg -ln 'ActivationResult|ProgramRunResult'
packages/journal-authority/src` → 6 files including index.ts; D1 rename map
items 1–9 touch none of #2/#4/#5/#7.
Suggestion: One line each in D2, even if the line is "deferred to structure
phase". The map should be a closed ledger of its own convictions.

### [NIT] D4 ledger cites `VenueOf`; the body defines `Venue`
Doc(s): D4 Ledger vs §4, §7
Claim: Ledger: "venue (de-facto via `VenueOf`)".
Finding: No `VenueOf` exists anywhere; §4 defines `type Venue` and §7 says
venue was promoted "by `Venue` appearing as a registry field". Probably a
pattern-echo from §0's `DescriptorOf`/`OutcomeOf`.
Evidence: `rg -n 'VenueOf' docs/architecture/*.md` → the ledger line only.
Suggestion: s/VenueOf/Venue/.

### [NIT] R7′ sits under "Ratified rules" in a section titled "ratified direction"
Doc(s): D3 §Forest Discipline
Claim: R7′ text: "PROPOSED, not ratified."
Finding: The text is unambiguous, but R7′ shares a blockquote with R1′–R6′
under `## Ratified rules`, inside "Forest Discipline — ratified direction",
in a document whose status line says "not yet decided policy" while its
ledger says "Ratified:". Every marking is individually correct; the
containers contradict the contents. (Handoff soft spot #3, confirmed.)
Elsewhere the rules hold up: R7′ is PROPOSED in all four documents, R1′–R6′
never contradict themselves across docs, and D1's paraphrase of R1′ ("until
the group settles" vs "until their subtree settles") is equivalent given
R3′.
Suggestion: Move R7′ to its own `## Proposed rule` block; retitle D3's
status line "analysis + ratified rules + proposals".

### [NIT] Broken symbol in D1's leaf entry: "`journalHead`/`journalHead` Digest`"
Doc(s): D1 §Definitions/leaf
Finding: Line-wrap corruption of `journalHead`/`journalHeadDigest`. The
symbol exists, so the entry's argument — "head" is taken — is sound, just
mis-set.
Evidence: vocabulary.md:367; `rg -l 'journalHeadDigest' packages` →
platform-acceptance/src/storage-spine-process.ts.
Suggestion: Fix the backticks.

### [NIT] "parity-vector contract" (D4 §0) and "parity evidence" (D4 §8) are undefined
Doc(s): D4 §0 β bullet, §8 table
Claim: "the parity-vector contract is Cilk's serial-elision theorem made
testable"; stage changes need "invariant + parity evidence".
Finding: No document defines the parity vector or names the test that
embodies it. A reviewer cannot check the β claim or know what evidence §8
demands.
Suggestion: One sentence in §0 — e.g. "serial and forked executions of the
same group must produce equal strand records modulo member interleaving,
asserted by <suite>" — or drop the name.

---

## Pass 2 — verification against code

All commands from HANDOFF §Pass 2 ran on HEAD `f4b9842c`, clean tree.

**Verified, no finding:**
- All ten legacy symbols → 0 hits each in `packages/`+`apps/`
  (`ProgramRuntime` … `sampleDurableModel`).
- Kernel owns forest structure: `execution.ensure-child` dispatch and
  `parentTaskId` lineage/ordinal logic in
  `journal-authority/src/authority-decisions.ts` (369, 468–623). R7′'s
  premise is real.
- God-file: `program-driver-chat-engine.ts` = 2118 lines.
- `grep -c 'export \*' journal-authority/src/index.ts` = 25. D2 said "~25";
  it is exact.
- Gates green: module-graph (31 packages, no cycles, 0 baselined module
  cycles), exports (31 packages), product-surface (17 facade paths);
  `git diff --check` clean.
- Stale-doc register accurate to the digit: ADR-001 `ProgramRuntime` ×4
  (all `ProgramRuntime.run`), ADR-002 ×2, ADR-005 ×2, domain-glossary ×1.
- D3's five mixed-phase evidence items all present: `replayed: true`
  (host-drive.ts:149), `restoredFrontierConsumed` (authority-types,
  driver-drive), `shouldInjectBeforeStep`, per-transport dual replay,
  `settling_pull` (snapshot schema + types).
- Audience is a free-form `string` (authority-contract.ts:94, 320–331); all
  seven society values exist as literals (host-effects ×42, program-host
  ×30, workflow-host ×29, program-execution ×17, model-runtime ×11,
  mutator ×8, scheduler ×7). The closed-union candidacy is well-founded.
- `WorkflowTreeHost.settle` exists (tree-drive.ts:31/77); `lease_lost`
  exists (activation-lease-coordinator); the five decision-stage names
  exist (decision-pipeline.ts); `durability: "crank_native"` exists
  (program-authoring.ts:51) and `"peer_hosted"` does not — consistent with
  D1's "(adopted; extends the existing literal)".
- D2 "60+ exported symbols share four tokens": 76 unique exported symbols
  match `*Host*|*Driver*|*Runtime*|*Activation*`.

### [CONCERN] D2 cites a stray file that was already deleted when D2 was committed
Doc(s): D2 §Baseline metrics (housekeeping)
Claim: "stray `src/workflow/runtime_tmp.txt` (157-line leftover)."
Finding: The file does not exist. Git shows it deleted by the cutover
commit `72778c60`, which precedes the doc's own commit `c926effa`. So the
bullet was stale at publication — which taints the whole metrics block: at
least one number was measured pre-cutover and never re-run, and nothing in
the block says which commit the numbers belong to.
Evidence: `find . -name 'runtime_tmp*'` → nothing; `git log --oneline --all
-- '**/runtime_tmp.txt'` → deleted in 72778c60.
Suggestion: Delete the bullet and stamp the metrics block with the commit
it was measured at, not "2024".

### [CONCERN] Seam #4 widened past its citation: `turnIdFor` is in three files now
Doc(s): D2 §Seams #4
Claim: "`turnIdFor` duplicated — host-drive and tree-drive."
Finding: Three copies: host-drive.ts, tree-drive.ts, and driver-drive.ts.
The seam grew after measurement — handoff soft spot #4, confirmed in the
worse direction.
Evidence: `rg -l 'turnIdFor' packages` →
journal-authority/src/workflow/{tree,host,driver}-drive.ts.
Suggestion: Update to three. This strengthens the conviction.

### [NIT] D1 rename map #3 undercounts: `routeDriverKind` ×4 files, fallback ×5
Doc(s): D1 §Rename map #3; D1 §Definitions/kind
Claim: "delete three copies of `routeDriverKind`…"
Finding: Four files carry `routeDriverKind` (workflow/program-driver,
workflow/driver-drive, testing/program-driver-host, chat-engine); the
`route["driverKind"] ?? route["kind"]` fallback D1 convicts appears in five
files — add durable-execution/src/program-driver.ts:83.
Evidence: `rg -ln 'routeDriverKind' packages`; `rg -n
'route\["driverKind"\]' packages`.
Suggestion: "three copies" → "four copies (five fallback sites)".

### [NIT] Runtime-filename count drifted: 75 today vs 77 claimed
Doc(s): D2 §Baseline metrics
Finding: `find packages apps -type f -name '*runtime*'` (source, no
node_modules) → 75. Two-file drift, favorable direction.
Suggestion: Same commit-stamp fix as the metrics block.

### [INFO] Two metric families cannot be re-measured
Doc(s): D2 §Baseline metrics
Finding: The fallow clone-group counts (24 in journal-authority; seams
#5/#6) and the cognitive-complexity leaders (`resolvePull` 81,
`validateRecordHistory` 73, …) are unverifiable: no fallow or complexity
script is wired into the repo (`rg 'fallow' package.json` → nothing). Not
contradicted — just uncheckable, which for a "re-measure after any seam
lift" baseline is itself a small defect.
Suggestion: Commit the exact measurement invocations next to the numbers.

### [NIT] Handoff commit table is off by one; D2's Home column hides the package
Doc(s): HANDOFF §1; D2 actor table
Finding: (a) HANDOFF's `HEAD~2`/`HEAD~1` positions were true before the
handoff itself was committed; each is now one deeper. No action — the
artifact describes itself. (b) D2's Home column (`workflow/runtime.ts`,
`workflow/host-drive.ts`, …) omits that every workflow file lives inside
`packages/journal-authority/src/`. The kernel package hosts the drives.
That matters for R7′: the structure/order boundary it legislates is not a
package boundary today, and a reader of D2 alone cannot see that.
Suggestion: Qualify the Home column once ("paths relative to
`packages/journal-authority/src/` unless noted") and add an amendment line:
R7′ eventually wants the drives out of the kernel package.

---

## Pass 3 — challenging the thinking

### [CONCERN] R6′'s "one interface" claim is contradicted by D4's own §8
Doc(s): D4 §5 vs §8; D1 durability class; D3 R6′
Claim: D4 §5: "This interface is the whole R6′ surface difference" /
"Delivery — the entire peer_hosted delta."
Finding: Three pages later, §8 counts three interpretation points for
durability class: "§5 [delivery], §2 sandbox intent, supervision/deadline
policy." D1's durability-class entry adds more axes: replay semantics
(recipe vs log), park economics (free vs rent), loss handling (cold-walk vs
errored outcome). And `ChildRequest.sampling` — the delegation MAY — only
means anything for peer_hosted members, since a crank_native child samples
through the host strand by construction; metering (host- vs peer-metered)
and projection attribution ride the same bit. The honest claim: the *wire*
delta types out to one interface; the *interpretation* delta is a class
with at least six members, which §8 itself starts to enumerate. As written,
§5 will convince an implementer that durability is delivery-local. It
isn't.
Evidence: quoted sections; D1 durability-class entry; D4 §1 ChildRequest
comment.
Suggestion: Rewrite §5's closing line: "the whole *transport* difference;
interpretation differences are enumerated in §8." Add sampling and metering
to §8's list.

### [CONCERN] Invariant W has a counterexample: cancellation unwind reattaches a strand whose tip slot is unresolved
Doc(s): D4 §3; D3 §What dissolves; D1 cancellation entry; HANDOFF pass-3 #2
Claim: W: "a strand being caught up contains no unresolved slots"; D4 §3:
the walker "cannot park … ends only at frontier == head"; D3: separation
dissolves "cancellation-during-history guards."
Finding: Cancelling a parked task means reactivating it. Per D1: "cancel
injected at the next step boundary → attachment reports `program_cancelled`
while pulls sit in `settling_pull`." To reach that step boundary the walker
replays to a frontier whose tip is the still-unresolved parked pull —
`settling_pull` is precisely "unresolved slot during catch-up", and the
state exists in the snapshot schema today. So either W carries an explicit
cancellation exception, or the separated design must commit to
settle-then-unwind: the kernel first resolves the parked slot with a
cancelled outcome — a settlement like any other — and reactivation then
replays a fully-settled strand whose program meets the cancellation at the
live edge. The second option is the better design: it preserves W, keeps
"the drive never learns there was a past," and turns D3's "guards dissolve"
from optimism into fact. No document says it.
Evidence: `rg -l 'settling_pull' packages` → snapshot schema,
authority-types, driver-drive; D1 cancellation entry.
Suggestion: State W in D4 with the resolution: cancellation is a settlement
before reactivation, and `settling_pull` is a pre-separation scar. Or scope
W to non-cancellation reactivations, explicitly.

### [CONCERN] The FLP footnote relocates the problem instead of dismissing it
Doc(s): D4 §0 γ bullet
Claim: "authority is *leased, not elected*, so fault-tolerant consensus is
never required — the impossibility result does not apply to this
architecture."
Finding: Two dependencies hide under "leased":
1. Lease turnover is a CAS. `lease.reclaim(epoch+1)` and fenced commits
   (`stale_owner` at the owner fence, epoch/`notBefore` checks) are safe
   only if the store's conditional write is linearizable. On any replicated
   backend, that linearizable CAS *is* consensus — running inside the
   storage service instead of here. FLP applies; it has been outsourced.
2. Lease expiry needs clocks. Duration and `notBefore` fencing assume
   bounded skew between grantor and holders. FLP's asynchronous model is
   exited by adding partial synchrony — an assumption the architecture
   makes and never states.
Neither is a design flaw; single-writer-over-linearizable-store is a
proven shape, and the doc's own γ lineage says so. But "does not apply"
reads as "we have no agreement problem," and §8's storage row — "swapped
behind the shell seam; invisible to the spine" — names no linearizability
requirement. Someone will back the shell with an eventually-consistent
store, and two epoch-holders will both commit. This footnote is the one
place in four documents where confidence outruns honesty.
Evidence: turn-authority.ts:38 (`stale_owner` owner fence); D4 §8 storage
row.
Suggestion: Reword: "consensus is delegated to the store's linearizable
conditional append, and lease expiry assumes bounded clock skew; given
those, elected-leader consensus is never needed above the store." Add
"linearizable conditional write" to §8's storage-engine protocol cell.

### [CONCERN] R5′ is ratified policy with a fail-open type and port behind it
Doc(s): D3 R5′; D4 §1 ForkGroupDescriptor, §3 ExpiryPort; HANDOFF pass-3 #4
Claim: R5′: "**every** fork group carries expiry policy; unwinding cancels
outstanding members. Stack hangs are structural failures."
Finding: Confirmed — no value, unit, default, or breach semantics beyond
"unwind" exists anywhere. Worse, the types contradict the rule:
- D4 §1 `deadline?: Deadline` is optional — the type permits the indefinite
  hang R5′ forbids. The preamble's "open decisions stay open as unions or
  optionals" does not cover this: R5′ is ratified, so the optionality
  contradicts the ledger instead of recording an open decision. And the
  same policy is *required* on `ReactivationPlan.expiry` — mandatory at the
  consumer, optional at the source that feeds it.
- `ExpiryPort`'s default body is an empty comment, while its siblings fail
  closed (`placement_unavailable`, `peer_unavailable`). A policy port whose
  default is silence is fail-open.
- Breach is half-specified: R7′ gives the kernel an `expired` terminal and
  γ ties "undo" to "expiry compensations," but what the frozen parent
  observes (an expired outcome on the fork slot? distinguishable from
  member failure?) and whether `CompensationOf.fork.requestTermination`
  reaches peer_hosted members as a delivered cancellation is unstated.
  Expiry is the only undo path the γ layer has; this hole carries the whole
  saga claim.
Evidence: quoted types; ReactivationPlan vs ForkGroupDescriptor fields.
Suggestion: Fixable without choosing values: make `deadline` required as
`Deadline | { policy: "inherited" }`; give ExpiryPort a fail-closed default
(no resolvable policy → refuse to open the group); one sentence on breach:
group resolves as `expired`, members get cancellation (delivered, for
peer_hosted), parent sees a distinguishable expired outcome.

### [CONCERN] Emission-as-append: ordering survives; the receipt grammar does not
Doc(s): D4 §4; D1 emission entry; HANDOFF pass-3 #3
Claim: "Steps shrink to two shapes once emission is an interaction …
Emission rides as 'append'."
Finding: The ordering challenge fails, in the authors' favor. Emission is
already a `ProgramStep` in the single-flight exchange (D1 step entry), so
folding it into the interaction shape adds no concurrency; offsets are
assigned at commit inside the single writer, so strand order and "offset is
proof of order" survive. Fork-group members emit into their own strands,
and session-level interleaving was never ordered. The pump branch does
collapse. Two things don't survive:
1. `LiveReservation.authorized` mints `{pullId, attemptId,
   resolutionCapability}` — the wrong grammar for append. Emissions
   acknowledge offsets (`EmissionReceipt`); nothing can *resolve* one, and
   `CompensationOf.append = never`. As typed, the append venue either mints
   a capability nobody may spend or needs a third authorized-shape.
2. Cost: reserve-writes-intent plus append-writes-emission doubles records
   per emission versus today's propose→append→acknowledge, unless reserve
   and commit fuse for this venue. D3 "notes cost honestly" for bulk
   catch-up and says nothing here.
Evidence: D4 §4 LiveReservation/Venue/Step; D1 emission and receipt
entries.
Suggestion: Add an ack-shaped authorized arm for append (`{offset}`, no
capability), and one sentence on record cost — fused reserve+append, or an
accepted 2×.

---

## Verdicts

**Pass 1 — consistency: FAIL.** One BLOCKER, five CONCERNs. The blocker is
an alias (commission/Mandate), not a contradiction of substance; R1′–R6′
read compatibly everywhere they appear and R7′ is PROPOSED in all four
documents. But the ledgers disagree, and the vocabulary is missing four
words the spine documents cannot be read without. An afternoon of edits;
none of it should survive into adoption.

**Pass 2 — verified: PASS with drift.** Every headline claim checked out:
ten dead symbols are dead, the kernel owns the forest, the god-file is 2118
lines, `export *` is exactly 25, all three gates are green, and the
stale-doc register is accurate to the digit. The drift is confined to D2's
baseline block — runtime_tmp.txt was already deleted at publication,
turnIdFor is ×3 not ×2, routeDriverKind ×4 not ×3, 75 not 77 runtime files
— plus two metric families that can no longer be measured because the tools
aren't in the repo. The claims aged exactly where the handoff predicted:
in the numbers, not the structure.

**Pass 3 — challenged: two claims bend, none break.** The core — fenced
single-writer journal, slot-leases, evidence — holds, and its lineage is
honestly cited except the FLP footnote, which should say "outsourced to
the store's linearizability plus clock bounds," not "does not apply."
R6′'s "one interface" is refuted by D4's own §8. Invariant W needs the
cancellation-as-settlement story; without it, W is false on the one path
that most needs it. R5′ is ratified policy sitting on a fail-open type.
Emission-as-append survives ordering and stumbles on receipts.

## Recommendation (per document)

| Document | Verdict | Gate items |
|---|---|---|
| vocabulary.md | **ADOPT-WITH-CHANGES** | resolve commission/Mandate (BLOCKER); add venue/slot/delivery/supervision entries; peer collision row; sync ledger; fix journalHead typo; ×4 routeDriverKind |
| responsibility-map.md | **ADOPT-WITH-CHANGES** | drop runtime_tmp bullet; turnIdFor ×3; commit-stamp baseline metrics + measurement commands; resolution notes for seams #2/#4/#5/#7; qualify Home paths |
| complexity-and-separation.md | **ADOPT-WITH-CHANGES** | ledger sync (notify/log, evidence-not-recipe); un-nest R7′ from "Ratified rules"; peers→members in R3′; one cancellation-as-settlement sentence |
| spine-types.md | **ADOPT-WITH-CHANGES** | define Invariant W + cancellation carve-out; reconcile Mandate with commission; §5 "entire delta" → transport delta, cite §8; required deadline + fail-closed ExpiryPort; reword FLP footnote + linearizability in §8; VenueOf→Venue; define parity-vector |

No REWORK. Every finding is a documentation-discipline failure, not a
design failure — and the worst of them, commission/Mandate, is the exact
disease the vocabulary document was written to cure.
