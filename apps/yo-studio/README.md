# yo-studio

> **Status: North-star vision.** Nothing in this app exists yet. This README is the
> destination — a concrete, end-to-end picture of what a full sweatpants assembly
> looks like when the current design memos (journal-native portable agents,
> crank-native durable remote tools, callee-authoritative A2A peers, and a future
> "code mode v2" over validated IR) have all landed. We build toward this; we
> measure new designs against it.

yo-studio is a product team's sweatpants deployment: a few agents, a foreign MCP
server, some leaf tools, and a chat surface — composed dynamically by the model
into durable, verifiable, human-gated workflows.

---

## The deployment

**Agents (journal-native programs on the manifest):**

- `design-reviewer` — chat agent, vision-capable model route, guidance resources
  on the team's design system
- `copywriter` — sub-agent, pinned tone-of-voice resource package
- `eng-estimator` — an A2A **peer** at the platform team's deployment (their
  journal, their credentials; we hold a grant set for two delegated effects)

**Foreign MCP server:** Figma. No durable-effects extension, so every Figma call
is an *opaque at-least-once effect* — read-heavy ops are naturally idempotent,
and that classification is recorded in the adapter's contract.

**Leaf tools:** `slack.post`, `jira.createIssue`, `contrast.check` (pure WCAG
math), `image.diff`, `storage.put` (content-addressed, returns digest refs).

Everything above is a **closed capability map**; a projector renders it as a
typed SDK per session — the "here is your SDK" surface the model composes
against.

---

## The problem

PM types into chat:

> "We shipped the new checkout flow but design says prod drifted from the Figma
> spec. Audit all 9 checkout screens against the Figma file, flag accessibility
> regressions, get Dana to confirm which ones matter, then file Jira tickets and
> post a summary to #checkout-launch. Don't file anything without Dana's
> sign-off."

## Turn 1 — the model chooses composition over call-chaining

The routed model sees a task with fan-out (9 screens), a mid-workflow human
gate, and conditional writes. Twenty tool-call round trips would be miserable
and un-resumable as a unit. It emits a program against the projected SDK:

```ts
export function* checkoutAudit(input: { figmaFileKey: string; screens: ScreenRef[] }) {
  const frames = yield* figma.getFrames({ fileKey: input.figmaFileKey });

  // fan out: one child per screen, bounded
  const audits = yield* all(input.screens.map((screen) => audit(screen, frames)));

  const flagged = audits.filter((a) => a.violations.length > 0);
  if (flagged.length === 0) {
    yield* slack.post({ channel: "#checkout-launch", text: summary(audits) });
    return { filed: [], clean: true };
  }

  // HITL gate — may park for days
  const decision = yield* elicit.review({
    to: "dana",
    title: "Checkout drift audit — confirm regressions",
    items: flagged.map(toReviewCard),   // includes image.diff artifact refs
  });

  const tickets = [];
  for (const item of decision.approved) {
    const ticket = yield* jira.createIssue({
      project: "CHK",
      summary: item.title,
      description: item.evidence,
      idempotencyKey: item.screenId,     // at-least-once discipline
    });
    tickets.push(ticket);
  }
  yield* slack.post({ channel: "#checkout-launch", text: summary(audits, tickets) });
  return { filed: tickets, clean: false };
}

function* audit(screen: ScreenRef, frames: FrameIndex) {
  const spec = yield* figma.exportFrame({ frameId: frames.byName[screen.name], format: "png" });
  const prodShot = yield* screenshot.capture({ url: screen.prodUrl });
  const diff = yield* image.diff({ a: spec.ref, b: prodShot.ref });
  const contrast = yield* contrast.check({ image: prodShot.ref });
  const assessment = yield* designReviewer.assess({   // vision sub-agent
    spec: spec.ref, prod: prodShot.ref, diff: diff.ref, contrast,
  });
  return { screen, violations: assessment.violations, evidence: diff.ref };
}
```

Note what the model *didn't* have to think about: durability, replay, idempotent
Jira retries beyond supplying the key, what happens if Dana takes 3 days. The
pull boundary owns all of it.

## Admission — milliseconds, before anything runs

Compiler lowers to IR → validator → policy predicates. The `while`-free subset,
`all` with a statically visible fan-out, the elicit gate — all become tree
facts. The PM's chat pane renders the **effect-plan card**:

```
┌─ Proposed workflow: checkout-drift-audit ─────────────────┐
│ Touches:  figma.getFrames ×1 · figma.exportFrame ≤9       │
│           screenshot.capture ≤9 · image.diff ≤9           │
│           contrast.check ≤9 · design-reviewer.assess ≤9   │
│           elicit → dana ×1                                │
│           jira.createIssue ≤9  ⚠ write, gated by elicit ✓ │
│           slack.post ×1        ⚠ write, terminal          │
│ Verified: no write precedes the approval gate             │
│ Est. cost: ≤ 9 vision samples · Figma reads only          │
│                                    [Run]  [Edit]  [Deny]  │
└───────────────────────────────────────────────────────────┘
```

The line that matters: **"no write precedes the approval gate"** is a
machine-checked tree predicate, not a promise. PM clicks Run. The tree is
digest-pinned, journaled as the task's program identity.

## Execution — the crank does its thing

- Root task spawns 9 children under `all` (`root.0`…`root.8`), each replaying
  independently.
- Figma MCP calls dispatch through the foreign adapter — opaque, at-least-once,
  results journaled with payload fingerprints. One export times out; re-dispatch
  with the same correlation ID, harmless (read-only).
- `design-reviewer.assess` calls route through the placement-aware
  `model.sample` — the PM watches token streams on the **activity stream** in
  the chat UI; only bounded semantic outcomes hit the journal.
- Nine audits finish in ~4 minutes. Six screens flagged. The elicit fires: Dana
  gets a review card (Slack link → elicit UI with side-by-side diffs served from
  `storage.put` refs).

**And then: nothing.** The turn parks. Generator destroyed, no process, no
lease, no timer. The journal holds a pending wait addressed to Dana. The PM
closes the laptop.

## Two days later

Dana opens the review, approves 4 of 6, annotates one ("intentional — new brand
color"). Her `respond` lands as a durable command; the coordinator marks the
session runnable; a fresh crank activation anywhere in the fleet:

1. Loads the journal, builds replay indices
2. Fresh generator from the pinned tree, replays 40-odd recorded results
   synchronously — no Figma calls, no model samples, no screenshots re-run
3. Reaches the elicit pull, finds it answered, continues **live**
4. Files 4 Jira tickets (idempotency keys mean the one that raced a crash last
   Tuesday would still have filed once), posts to Slack, closes the turn

Meanwhile — different session — the PM had *also* asked "get me an eng estimate
for whatever Dana confirms." That workflow's `engEstimator.estimate` call went
out over the **peer protocol**: their journal owns their task, our journal holds
the obligation; when their estimator needed our sprint-capacity data, it came
back as a **delegated effect** we resolved locally without ever shipping them
credentials. Both sides recorded matching causal digests. Nobody wrote glue
code for any of this.

## The compounding part

PM, in chat: *"that audit was great — keep it."*

```
Promoted: checkout-drift-audit@sha256:9f3a…
 → named entrypoint on yo-studio's manifest
 → advertised as A2A skill (effect inventory published from the tree)
```

Next month someone types "run the drift audit on the onboarding flow" — the
model doesn't recompose; it *calls the skill* with new inputs. And when the
platform team's agent wants to run our audit against *their* Figma files, they
fetch the tree, statically verify its effect inventory against the grant set
they're willing to offer, and evaluate it on their own kernel. They never
trusted our code — they read our data.

## What the human actually experienced

1. Asked for a thing in one paragraph
2. Approved a card that told the truth mechanically
3. Went home
4. A colleague clicked approve on 4 items two days later
5. Tickets appeared, Slack summary appeared, exactly once each
6. Said "keep it" and the org got permanently more capable

No YAML, no DAG editor, no "the workflow engine lost state," no 2am retry storm
double-filing Jira tickets.

---

## What this depends on

| Capability in the story | Where it lives today |
| --- | --- |
| Durable sessions, parking, replay | `@sweatpants/session-contract`, replay-crank-driver design |
| Crank-native durable tools, pull boundary | crank-native-durable-remote-tools design |
| Closed capability maps, symbolic call-waits | wait-based-session-kernel design |
| Agent manifests, pinned program identity | agent-resource-artifact-identity + durable-chat-agent-authoring specs |
| Foreign MCP adapter (opaque at-least-once) | foreign-a2a-durable-task-adapter design, `session-contract/foreign-tool-*` |
| A2A peer with delegated effects | callee-authoritative-sweatpants-a2a-peers design |
| Placement-aware `model.sample` | placement-transparent-model-sampling spec |
| Activity stream vs semantic journal | journal-native-portable-agents design |
| **Code mode v1** (LLM-composed generator programs, admission pipeline, effect approval) | *not yet designed — next memo* |
| **Code mode v2** (restricted subset → validated IR, effect-plan card, static policy predicates) | tisyn research (`protocols/tisyn/`), deliberately deferred |
| Skill promotion (content-addressed workflow → manifest entrypoint) | future — builds on resource identity |

The rows above the code-mode line are approved designs or shipping substrate.
The rows below are what this app exists to pull into being.

## Delivery arc

1. **Phase 0** — capability-surface projector: manifests → typed SDK projection.
   Valuable standalone (better tool docs for tool-call mode).
2. **Phase 1** — code mode v1: `composeWorkflow` as a separately authorized
   tool; rejecting purity gate; isolated driver only; elicit-before-execute.
3. **Phase 2** — measure divergence, gate failures, and approver comprehension;
   decide whether tisyn IR earns its slot.
4. **Phase 3** — skill promotion, cross-org tree exchange.

yo-studio becomes real one phase at a time; this README stays the target.
