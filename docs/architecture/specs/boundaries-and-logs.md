# Boundaries & Logs: How Interaction Kinds Flow

One-page reference. The question every layer answers: **who resolves, and
what does the log own?**

## The rule

A durable program never calls outward while running. It *proposes* a pull,
the kernel journals the request verbatim, execution parks. Named pull kinds pin their input/output descriptors in `DurableProgramManifest.pulls`; Authority validates without replacing the proposed journal value. Something resolves
it; the answer lands in the journal; replay uses the recorded answer and never
re-executes. Three cases differ only in **who the resolver is** and **what
happens outside our authority**.

## Case 1 — Within-authority interactions (`elicit`, `sample`)

```
program ──propose──▶ [journal: PullRequested]          park
   ▲                                                        │
   └──replay settled value◀─[journal: PullResolved]◀── host resolver
```

- Resolver: the host itself (UI interrupt path; modelSamplingService). Embedded model context stages into an object source before reserve; remote evaluators cross an explicit sample-staging composition edge before Authority.
- Files: park via `workflow/runtime.ts` ops → facade dispatch
  (`durable-tool-session-facade.ts`, generic block) or engine registry
  (`program-driver-chat-engine.ts`) → sample transport:
  `model-sampling/src/effect.ts::executeModelSamplePull`.
- Log owns: the full request and response. External world: none involved.

## Case 2 — External tools that don't know us (`ephemeral`)

```
program ──propose──▶ [journal: PullRequested{driver,tool,input}]   park
   ▲                                                                    │
   └──replay◀─[journal: PullResolved]◀── host executes LIVE call out ───┘
```

- Resolver: facade's ephemeral resolver → `ephemeral-tool-session.ts::executeEphemeralToolCall` over the invocation host (worker boundary). Interactive chat tools use the pinned ephemeral adapter workflow child so nested sample/elicit exchanges remain ordinary child topology.
- The external tool sees an ordinary function call. It learns nothing about
  durability. Death of the live reference = `ephemeral_reference_lost` error —
  there is nothing honest to replay otherwise.
- Log owns: verbatim exchange. Authority stays home.

## Case 3 — Peer authorities (future, deliberately unbuilt)

```
[your journal]  send request ···· waits on correlation ···· receive reply
                                        │
                              [their journal]  their loop, their clock
```

Another agent loop is not a function; parking on it holds our durability
hostage to their uptime. This wants cross-authority message correlation —
its own primitive, two logs, zero shared authority. NOT a pull kind. Enter it
as a new top-level concept when real consumers exist; the registry makes that
additive. Until then this row is intentionally empty of code.

## Registry map

| Layer | Sees kind names | Where |
|---|---|---|
| Kernel ledger | yes (data) | `authority-contract.ts`, kind modules `src/pull-kinds/*` |
| Program context | no — single `context.pull(descriptor)` | `durable-execution/program-authoring.ts` |
| Authoring sugar | yes, by design | agent-sdk `durable-create.ts`, runtime op factories |
| Hosts | no — registries only | facade generic block; engine `parkedPullResolvers` |
| Kind transports | yes (their home) | `ephemeral-tool-session.ts`, sampling service |

Policy lives with kinds (`pull-kinds/*.ts`: schema, audience, gates, labels);
snapshot codec derives from the same registry. Adding case-3 later = new
module + registration, nothing else.
