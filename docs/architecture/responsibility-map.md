# Responsibility Map — Authority-Backed Effection Workflow Runtime

> **Design-authority notice:** The approved [durable execution spine design](../../../.pi/specs/durable-execution-spine-design.md) is normative for Venue, Step, attribution, replay, peer strands, Mandate, R7′, and the `ephemeral` rename. The measurements below remain useful; superseded ownership sketches are not current design.

One page. Each actor gets one sentence per cell. A cell that cannot be filled
in one sentence is a convicted seam, listed below the table. Baseline metrics
at the bottom are the "before" numbers for any future refactor.

## Amendments — post-jam (forest discipline & spine types)

The actor table below reflects pre-jam naming and is retained as the
today-code baseline; proposed renames live in
[vocabulary.md](./vocabulary.md). What changed since the baseline:

- **Structure vs order split (R7′, proposed):** the kernel owns concurrency
  *structure* — forest rows, slot lifecycle, terminal algebra including
  `expired` — while hosts own evaluation order. The kernel row's "sole
  mutator" claim now includes enforcing structural refusals.
- **Fork groups** supersede separate invoke/all/race handling in the tree
  coordinator; failure propagation becomes a declared `SupervisionStrategy`.
- **Mandate / ReactivationPlan** formalize bind-time facts (placement,
  capability, addressing), retiring the capability-binding seam (#3) as a
  design target rather than an open question.
- **DeliveryPort** carries the entire peer_hosted delta (`durability:
  "peer_hosted"` children receive deliveries instead of sharing the strand).
- **Storage** is confirmed as the shell's state strategy beneath the kernel
  contract — never a port; change protocols in [spine-types.md](./spine-types.md) §8.

## The actors

| Actor | Home | Owns | Collaborators | Explicitly does NOT own |
|---|---|---|---|---|
| Authority kernel | `journal-authority` decision-pipeline, commit-loop, execution-forest | Validating and committing every semantic record; sole mutator of durable journal state | store/repository; pull-kind policies | What records mean to hosts or programs |
| Pull kinds + registry | `pull-kinds/*` | Typed interaction descriptors and per-kind authorization policy | kernel decisions | Executing interactions; host wiring |
| Workflow runtime | `workflow/runtime.ts` | The Effection attachment resource: open/exchange/close lifecycle; replaying settled pulls into a fresh run | authority port; pull settlement | Durability decisions; transports beyond the in-process handle |
| Host drive (`driveActivation`) | `workflow/host-drive.ts` | One in-process attachment from start to park-or-terminal, including closure normalization | workflow runtime; HostAuthority port | Child topology; remote transports; restore/fencing |
| Driver drive (`driveProgramDriverActivation`) | `workflow/driver-drive.ts` | One process-independent evaluator attachment, including restore proofs, fencing, cancellation injection | ProgramDriver peer; full authority contract | Child topology; in-process pumping |
| Tree drive (`driveWorkflowTree`) | `workflow/tree-drive.ts` | Recursion over invoke parks: ensure-child, activate child, settle parent | an injected `activate` operation; execution.ensure-child | How one activation pumps; parking policy |
| Evaluator adapter (`createWorkflowProgramDriver`) | `workflow/program-driver.ts` | Bridging the ProgramDriver transport contract onto the drives | durable-execution peer protocol | Journal state; placement policy |
| Pull resolvers (e.g. parked-sample) | `durable-handler/parked-sample-resolver.ts`, registry | Settling one parked pull given descriptor + placement evidence | sampling service; source stager | Proposing pulls; journal mutation |
| Facade composition | `program-workflow-host.ts` | Assembling a session's runtime pieces: resolver registry, staging edges, delivery writers | chat activation; model-sampling; authority shell | Projection of records into UI events |
| Chat composition root | `program-driver-chat-engine.ts`, `program-driver-chat-composition.ts` | Translating product parameters once into narrow capabilities, then sequencing private activation and capability-free presentation | chat activation; chat presentation | Authority decisions, evaluator mechanics, record folds, or publication policy |
| Chat activation | `program-driver-chat-admission.ts`, `program-driver-chat-activation.ts`, `program-driver-chat-runtime.ts`, `program-driver-chat-settlement.ts` | Admission, execution composition, participant settlement, and one private `ChatActivationReport` | Authority shell; ProgramDriver spine; effect and sampling services | AG-UI event construction, public snapshots, or terminal publication |
| Chat journal index | `program-driver-chat-journal-index.ts` | One immutable journal traversal → task, pull, correlation, tool-lifecycle, cancellation, and message relations | settlement; chat projection | Authority capability, evaluator state, publication policy, or product callbacks |
| Chat projection | `program-driver-chat-*-projection.ts`, `program-driver-chat-correlation.ts`, `program-driver-chat-projection-codecs.ts` | Indexed journal facts → public chat events, activity views, and interrupts | chat journal index; authored interaction bindings | Authority command/query capability, evaluator driving, settlement, or publication |
| Chat presentation | `program-driver-chat-presentation.ts` | Publishing projected checkpoints and terminal outcomes from a `ChatActivationReport` | product publication ports; pure projection | Authority access or evaluator advancement |
| Model sampling service | `model-sampling` | Actual model invocation and preparation artifacts, in both modes | context source resolver/stager | Journaling; when preparation happens |
| Evaluators (local/worker/agentcore) | `tool-runtime-local`, `tool-runtime-agentcore` | Executing program attempts within their placement; nothing else survives process death | evaluator adapter; fenced leases | Durable state; child allocation |

## Seams this exercise convicts

1. **"Host" names six unrelated roles** — `HostAuthority` (kernel port),
   `ProgramWorkflowHost` (facade), `WorkflowTreeHost` (composition policy),
   `ProgramDriverEffectHost` (effect routing), `HostScopeOwner` (Effection
   scope), `createHostModelSamplingService`. No cell above can say which is
   *the* host.
2. **Two result vocabularies for one outcome** — `ActivationResult` vs
   `ProgramRunResult`.
3. **Capability binding lives in three places** — `openProgramAttachment`
   minting, driver-drive `bindAttachment`, resumed-attachment paths.
4. **`turnIdFor` duplicated** — host-drive and tree-drive.
5. **Descriptor codec duplicated** — `pull-kinds/wire.ts` ↔
   `workflow/runtime.ts` (fallow dup group).
6. **Test shells duplicate production shell logic** — in-memory-shell ↔
   stored-shell ↔ scenario-driver (three fallow clone groups). Testing should
   consume production seams, not re-implement them.
7. **Uncurated public surface** — `journal-authority/src/index.ts` is ~25
   `export *` lines; depth requires hiding something, and this hides nothing.
8. **Optional placement evidence** — resolvers police at runtime what the type
   could guarantee statically.

## Baseline metrics (2024 refactor checkpoint)

Re-measure after any seam lift:

- Cognitive complexity leaders (kernel): `resolvePull` 81,
  `validateRecordHistory` 73, `verifyDurableAuthoritySnapshot` 63,
  `validateEntryEvidence` 57, `reservePull` 45. Pumps are modest:
  `driveAttachment` 23, `driveNode` 21.
- fallow: 24 clone groups in journal-authority alone.
- Vocabulary collisions: 60+ exported symbols share only four tokens
  (`Host`, `Driver`, `Runtime`, `Activation`); 77 files carry "runtime" in
  the name.
- Public surface: unbounded via wildcard re-exports.
- Housekeeping: stray `src/workflow/runtime_tmp.txt` (157-line leftover).

## Reading the map diagnostically

Rows that took longest to write, or needed hedging: the three drives (rows
4–6 share lifecycle duties the table cannot cleanly divide), and facade
composition vs chat engine (both touch elicitation). Those two boundaries —
activation lifecycle and projection ownership — are where the next lift
should aim, not because duplication is large but because this table could
not draw them in one sentence each.
