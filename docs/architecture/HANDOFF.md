# HAND-OFF — Fresh Review Session

You are reviewing an architecture jam produced over one long working
session. You have **no shared context** with its authors beyond this file,
the four documents under review, and the repository itself. That is the
point: your value is independence. Trust nothing in the documents because
they assert it — every checkable claim has a verification command below.

---

## 1 · Repository state

- Repo root: this directory (`sweatpants`), branch `rr/cordis-style-refactor`.
- `HEAD~2` `7eff3baf` — stable point before a large runtime cutover.
- `HEAD~1` `72778c60` — "complete authority-backed effection cutover":
  deleted `ProgramRuntime` orchestration; three workflow-native drives;
  `pull(descriptor)` as the single interaction primitive; ~40% net code
  reduction across 155 files.
- `HEAD~0..1` `c926effa` → `4243fb0a` — the **jam snapshot** and its
  **consolidation**: the four documents you are reviewing, plus
  `specs/` copies of prior design-stage documents from outside the repo.

Working tree should be clean (`git status --short` → empty).

## 2 · The documents, in reading order

| # | File | Question it answers |
|---|------|---------------------|
| 1 | `vocabulary.md` | What do our nouns mean, which collide, what renames are planned? |
| 2 | `responsibility-map.md` | Who owns what today, where are the seams convicted? |
| 3 | `complexity-and-separation.md` | Why is the system complex, what rule set governs forked execution (R1′–R7′)? |
| 4 | `spine-types.md` | What does all of that look like as types and call stacks? |

`specs/` is historical input, not under review — consult only when a
living doc claims something about earlier designs.

Read in order. Each assumes the previous. Total read ≈ 45–60 minutes.

## 3 · Review protocol — three passes

### Pass 1 — internal consistency (documents only)

- Do the RATIFIED / PROPOSED ledgers at the top of docs 1, 3, 4 agree with
  each other and with their own bodies?
- Does the collision table in doc 1 cover every multi-meaning word used in
  docs 2–4?
- Do the convicted seams in doc 2 have either a resolution note or a home
  in doc 1's rename map?
- Are R1′–R6′ stated identically everywhere they appear? Is R7′ always
  marked PROPOSED?

### Pass 2 — verify against code (independent evidence)

Run from the repo root; all should support the documents' claims:

```bash
# legacy symbols really are gone (expect 0 hits each):
for pat in ProgramRuntime journal-program-runtime runLocalProgramActivation \
           installJournalProgramRuntime withAuthorityTestScope \
           ephemeralToolChild ephemeralToolAdapterChild createLocalProgramHost \
           local-program-driver sampleDurableModel; do
  printf '%-32s %s\n' "$pat" "$(rg -n "$pat" packages apps --glob '!node_modules/**' | wc -l)"
done

# kernel really owns forest structure (doc 3's R7′ premise):
rg -n 'parentTaskId|ensure-child' packages/journal-authority/src/authority-decisions.ts | head

# the god-file claim (doc 2 baseline) still holds:
wc -l packages/durable-chat-runtime/src/durable-handler/program-driver-chat-engine.ts

# uncurated public surface claim (doc 2 seam #7):
grep -c 'export \*' packages/journal-authority/src/index.ts

# structural gates still green:
pnpm build:check && pnpm build:check
git diff --check
```

Anything whose result contradicts a document claim is a finding.

### Pass 3 — challenge the thinking

These are the authors' positions. Attack the weakest three by your own
judgment; do not accept them because they are confident:

1. R6′ claims the peer_hosted delta types out to one interface (`Delivery`).
   Is anything else hiding in that "class"?
2. Invariant W ("a strand being caught up contains no unresolved slots") is
   derived from R1′+R3′. Find a counterexample scenario if one exists.
3. Emission-as-append-venue collapses a pump branch. Does ordering survive?
4. R5′ expiry is ratified but has no values or default policy anywhere.
5. The α/β/γ provenance (spine-types §0) — is the FLP footnote honest, or
   does leased authority hide a real gap?

## 4 · Settled — do not relitigate

These were decided with evidence earlier and re-litigating them wastes the
session (challenge their *implementation*, not their existence):

- The journal is the sole durable authority; one fenced writer per
  task-epoch.
- `pull(descriptor)` is the single program-facing interaction primitive;
  kind-specific ergonomics live in authoring sugar.
- Raw authored descriptors are journaled verbatim; enrichment happens only
  at declared staging edges.
- Spawn-as-detachment is retired pending a real use case (R2′).
- Delegation of sampling to the host strand is a MAY (R6′).
- Children differ only in durability class + route (R6′); peers receive
  deliveries and never touch the journal.
- Structured concurrency discipline (ancestor freeze, lifetime-awaited
  forks) — R1′/R2′/R3′.

## 5 · Open shelf — fresh judgment explicitly wanted

| Item | Question |
|---|---|
| `leaf` vs `task-head` | Name for an open strand's tip ("head" is taken by `journalHead*`) |
| Attribution chains | On descriptors verbatim, or stitched at projection time? |
| Delegated audiences | Peer elicits spend participant audience directly, or transcode at fork boundary? |
| Handoff name | Replay→live-edge boundary word |
| Expiry values | Fork-group deadline defaults; what happens on breach besides unwind |
| Driver→Evaluator rename | Worth an ADR supersession? (ADR-001 references the old contract) |
| Zero-trust cold-start | Snapshots as disposable verified caches |
| Twin turns | Journal `turnId` vs conversation `activeLogicalTurnId` — equal by construction? |
| Session↔conversation cardinality | Enforced 1:1, or current practice? |

## 6 · Known soft spots — where we already suspect ourselves

Flagged by the authors; confirm or refute:

1. `responsibility-map.md`'s actor table uses pre-jam names; amendments
   section patches it but the table body may contradict the patch.
2. `vocabulary.md` supersedes `docs/domain-glossary.md` entries (notably
   Host) but domain-glossary itself has not been edited — divergence is
   documented, not resolved.
3. `complexity-and-separation.md` mixes analysis (done) with policy
   (ratified) and proposals — sections are labeled but the seams are soft.
4. Doc 2 seam #4 (`turnIdFor` duplicated) and #5 (descriptor codec dup)
   cite fallow clone groups; numbers may have drifted since measurement.

## 7 · Findings — format and destination

Write everything to `docs/architecture/review-notes.md` (create it).
One entry per finding:

```
### [SEVERITY] <one-line title>
Doc(s): …      Section: …
Claim: <what the document asserts>
Finding: <what is wrong, missing, or unverifiable>
Evidence: <command output / quote>
Suggestion: <smallest change that fixes it>
```

Severities:

- **BLOCKER** — a claim is false, a rule is contradictory, or a type cannot
  implement as written.
- **CONCERN** — true but fragile; will mislead someone within weeks.
- **NIT** — wording, drift, polish.

End the file with three verdicts, one per pass: consistency / verified /
challenged — plus an overall recommendation: ADOPT, ADOPT-WITH-CHANGES,
or REWORK per document.

## 8 · Ground rules for you as reviewer

- Verify before you believe; the commands in Pass 2 exist because every
  number in these documents came from a real run during the jam — but runs
  age.
- Disagree loudly in writing; agreement found nowhere in the file is worth
  nothing later.
- Time box: passes 1–2 ≈ 90 minutes, pass 3 ≈ 30. If BLOCKERs appear in
  pass 1, stop there and report — later passes assume consistency.
- Do not edit the four documents. Notes file only.
