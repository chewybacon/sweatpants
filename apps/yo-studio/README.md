# yo-studio

> **Status: First authored vertical.** The app now contains a real journal-native
> coding harness, a closed workspace capability map, a portable workspace and
> Lambda MicroVM deployment description, an Effection-native fenced finite-HTTP
> workspace runtime, Host effect registrations, a finite headless task endpoint,
> and a React UI built on `@sweatpants/react-chat/useChat` plus
> `createDurableChatHandler`. Local development executes the real journal-native
> program through a loopback connector; the same protocol has passed live Lambda
> MicroVM write/test/suspend/resume certification. The remainder of this README
> is the destination for the complete product-team assembly.

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
is an _opaque at-least-once effect_ — read-heavy ops are naturally idempotent,
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
        items: flagged.map(toReviewCard), // includes image.diff artifact refs
    });

    const tickets = [];
    for (const item of decision.approved) {
        const ticket = yield* jira.createIssue({
            project: "CHK",
            summary: item.title,
            description: item.evidence,
            idempotencyKey: item.screenId, // at-least-once discipline
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
    const assessment = yield* designReviewer.assess({
        // vision sub-agent
        spec: spec.ref,
        prod: prodShot.ref,
        diff: diff.ref,
        contrast,
    });
    return { screen, violations: assessment.violations, evidence: diff.ref };
}
```

Note what the model _didn't_ have to think about: durability, replay, idempotent
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

Meanwhile — different session — the PM had _also_ asked "get me an eng estimate
for whatever Dana confirms." That workflow's `engEstimator.estimate` call went
out over the **peer protocol**: their journal owns their task, our journal holds
the obligation; when their estimator needed our sprint-capacity data, it came
back as a **delegated effect** we resolved locally without ever shipping them
credentials. Both sides recorded matching causal digests. Nobody wrote glue
code for any of this.

## The compounding part

PM, in chat: _"that audit was great — keep it."_

```
Promoted: checkout-drift-audit@sha256:9f3a…
 → named entrypoint on yo-studio's manifest
 → advertised as A2A skill (effect inventory published from the tree)
```

Next month someone types "run the drift audit on the onboarding flow" — the
model doesn't recompose; it _calls the skill_ with new inputs. And when the
platform team's agent wants to run our audit against _their_ Figma files, they
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

| Capability in the story                                                                         | Where it lives today                                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Durable sessions, parking, replay                                                               | `@sweatpants/session-contract`, replay-crank-driver design                 |
| Crank-native durable tools, pull boundary                                                       | crank-native-durable-remote-tools design                                   |
| Closed capability maps, symbolic call-waits                                                     | wait-based-session-kernel design                                           |
| Agent manifests, pinned program identity                                                        | agent-resource-artifact-identity + durable-chat-agent-authoring specs      |
| Foreign MCP adapter (opaque at-least-once)                                                      | foreign-a2a-durable-task-adapter design, `session-contract/foreign-tool-*` |
| A2A peer with delegated effects                                                                 | callee-authoritative-sweatpants-a2a-peers design                           |
| Placement-aware `model.sample`                                                                  | placement-transparent-model-sampling spec                                  |
| Activity stream vs semantic journal                                                             | journal-native-portable-agents design                                      |
| **Code mode v1** (LLM-composed generator programs, admission pipeline, effect approval)         | _not yet designed — next memo_                                             |
| **Code mode v2** (restricted subset → validated IR, effect-plan card, static policy predicates) | tisyn research (`protocols/tisyn/`), deliberately deferred                 |
| Skill promotion (content-addressed workflow → manifest entrypoint)                              | future — builds on resource identity                                       |

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

## What is implemented now

The deployment uses the validated framework authoring surface rather than raw
configuration objects:

```ts
const workspace = defineWorkspace({
    source: workspaceSource.local("."),
    packageManager: "pnpm",
    scripts: { test: "pnpm test", typecheck: "pnpm check" },
    policy: {
        network: "trusted-development",
        writes: "approval",
        externalEffects: "trusted-development",
    },
    persistence: "sandbox_lease",
});

export default defineDeployment({
    name: "yo-studio",
    mode: "development",
    authority: developmentJournal(),
    modelProvider: codingModelProvider,
    modelSampling: hostModelSampling(codingModelProvider),
    programs: { code: codingHarness },
    capabilities: codingCapabilities,
    workspace,
    sandbox: lambdaMicrovm({
        image: {
            /* exact immutable image */
        },
        lifecycle: {
            /* ... */
        },
    }),
    projections: [reactChat(), headlessHttp(), streamableMcp()],
});
```

Definitions are closed, digest-addressed, and cross-validated. Production rejects
an in-memory journal, mandatory deny-network policy rejects incapable providers,
and checkpoint-recoverable workspaces reject providers without checkpoint restore.
The current Lambda certification uses explicit `trusted-development` network and
external-effect profiles because the provider image exposes `INTERNET_EGRESS` and
named `pnpm` scripts execute workspace-controlled code. Script names are policy
selectors, not a narrow code-execution boundary. The runtime contains each script
in a dedicated process group and kills the group on completion, timeout, or
cancellation, but it does not claim default-deny network enforcement.

- `src/programs/coding-harness.ts` — the existing durable chat authoring model
  composed with workspace child programs.
- `src/capabilities/workspace.ts` — one ordinary `WorkspaceFiles` context
  extension plus model-facing inspect, read, list, write, and named-script tools.
  Observations directly call `yield* context.workspace.readFile(input)` and return
  the observed `workspaceRevision`; mutations use one inline pull-ID-idempotent
  `context.record()` and pass its pull ID as the provider operation ID.
- `@sweatpants/workspace-runtime` — named `WorkspaceOperations`, the ordinary
  `WorkspaceFiles` API, direct local provider, remote connector provider, and a
  thin finite-HTTP adapter. Authored tools contain no fence or protocol details.
- `src/config.ts` — provider-neutral workspace policy plus the Lambda MicroVM
  placement profile, with no credentials or provider instance identity.
- `src/deployment.ts` — the authored reference assembly.
- `src/App.tsx` — a `useChat` consumer with structured tool-call cards, durable
  conversation identity, and an explicit New session action; it renders the HTTP
  projection without importing or owning the durable model loop.
- `src/server/durable-chat-application.ts` — `createDurableChatHandler` composed
  with ProgramRuntime-native workspace children and attachment-scope ordinary providers.

The primary UI calls `useChat({ baseUrl: "/api/chat" })`. The handler owns the
conversation, model loop, journal, native child programs, and workspace providers.
The deployment selects the `pi-ai` model provider (`github-copilot/gpt-5.5` by
default) and explicitly assigns journal-native `model.sample` ownership to the
Host. The headless projection consumes the same shape through an Effection-native
`CodingModelSampleProvider` port.
The separate `POST /api/tasks` endpoint remains as the finite headless projection;
it enters one owned Effection scope and opens the authored chat program through
`LocalProgramHost`. The built-in scripted model is deterministic demo
infrastructure only; production injects the deployment's model service without
changing either projection or the program. The conversation ID is retained in
`localStorage`, so refresh hydrates the same durable handler conversation; only
New session replaces that identity and remounts the hook.

`@sweatpants/sandbox-provider-aws` now interprets the Lambda deployment in the
Vite Host: the first ordinary workspace operation for each durable conversation allocates a
task-affine MicroVM, waits for readiness, mints short-lived port-bound auth,
binds the activation fence, and returns `createHttpWorkspaceConnector()`. New
session therefore creates a new conversation and a distinct MicroVM lease. The
Vite root scope terminates every owned lease on shutdown.

Set `YO_STUDIO_WORKSPACE_PLACEMENT=aws` together with
`YO_STUDIO_MICROVM_IMAGE_ARN` and `YO_STUDIO_MICROVM_EXECUTION_ROLE_ARN` to use
that path; there are no personal-account defaults. `AWS_PROFILE` is optional and
the UI reports the actual selected placement. The next implementation slice is durable production
journal storage plus workspace checkpoint materialization, so both Host restart
and MicroVM termination recover rather than only suspend/resume within a lease.
