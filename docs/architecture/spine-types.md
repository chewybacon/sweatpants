# Spine Types — Inputs, Outputs, Call Stacks

**Status:** Jam draft — type-level consequences of R1′–R6′ and the
vocabulary. Nothing here migrates data; compatibility notes at the end.

Every type name below is a glossary word or an explicitly flagged
candidate. Fields carry rule citations. Where a decision was open in
discussion, the type keeps it open as a union or optional — never
silently.

## 0 · Provenance and primitives

Three traditions compose; each contributes one layer:

- **α — interpreter core** (Plotkin/Pretnar algebraic effects; Felleisen
  control operators; SICP). Program = term; journal = trace; venues =
  handler layers; replay = re-interpretation of a dump prefix. Chosen
  because TypeScript + Effection supply the substrate: generators are
  resumable terms, scopes are handler contexts, Ports are middleware
  composition. Continuations are never serialized — the trace re-derives
  control (Invariant W).
- **γ — ledger discipline** (ARIES; Sagas; Event Sourcing). Every
  interaction is a saga step: intent journaled before commitment; recovery
  is analysis → redo (= replay walker) → undo (= expiry compensations);
  protocol compensation exists only where an open promise crosses an
  authority boundary. FLP footnote: authority is *leased, not elected*, so
  fault-tolerant consensus is never required — the impossibility result
  does not apply to this architecture.
- **β — supervision policy** (Erlang/OTP; Cilk serial elision; Smith).
  Failure propagation between group members is a declared combinator;
  deliveries are a mailbox view over the strand; the parity-vector contract
  is Cilk's serial-elision theorem made testable.

```ts
/** α — operations and the layers that interpret them. */
interface Op<K extends PullKindName> {
  readonly kind: K;
  readonly args: DescriptorOf[K];
}

/** γ — the strand is a saga ledger; these name today's two records. */
interface SagaStep<K extends PullKindName> {
  intent:      { pullId: PullId; descriptor: DescriptorOf[K]; offset: Offset };
  commitment?: { outcome: OutcomeOf[K]; receipt: Receipt; offset: Offset };
}

/** γ — compensation exists ONLY across authority boundaries.
    Output (append) and inline computation have none: root ① as a type. */
interface CompensationOf {
  elicit:  { retractQuestion: true };
  fork:    { requestTermination: readonly TaskId[] };
  foreign: { deliverCancellation: boolean };
  effect: never; append: never; sample: never; wait: never;
}

/** β — failure propagation between group members, OTP-named where the
    semantics genuinely match; race earns its own combinator. */
type SupervisionStrategy =
  | { type: "one_for_all" }     // "all": member fails ⇒ unwind group
  | { type: "first_success" }   // "race": member succeeds ⇒ cancel rest
  | { type: "single" };         // "invoke": one member, no siblings
```

## 1 · Composition — declaring children

```ts
/** R2′/R6′ — extends the existing literal on authored tools. */
type Durability = "crank_native" | "peer_hosted";

/** R4′ — who asked, through whom. Decided at proposal time, journaled verbatim. */
type AttributionChain = readonly PeerHop[];

/**
 * One child request. `durability` selects replay semantics (recipe vs log);
 * `sampling` is a declared MAY (R6′): "delegated" routes model calls through
 * the host strand; "local" keeps them peer-private. Declaration only — the
 * spine neither requires nor forbids.
 */
interface ChildRequest {
  program: PinnedProgram;
  input: Json;
  durability: Durability;
  route: ProgramRoute;
  sampling?: "delegated" | "local";
}

/**
 * One suspension point, one group. Unifies invoke/all/race behind `mode`;
 * spawn has no shape here (retired, R2′). The parent parks ON this record
 * (R1′ ancestor freeze) and resumes when the group resolves.
 */
interface ForkGroupDescriptor {
  kind: "fork";
  mode: "single" | "all" | "race";
  members: readonly ChildRequest[];
  /** β — declared failure propagation between members. */
  supervision: SupervisionStrategy;
  /** R5′ — groups may not hang indefinitely. */
  deadline?: Deadline;
}
```

Compatibility: existing journals keep `"invoke" | "all" | "race"` kinds.
New-shape forks are valid for new strands; readers accept both spellings
forever. No snapshot migration.

## 2 · Admission — reactivation plan → mandate

Two stages, one lineage. The plan exists before binding (no capabilities are
known); the mandate is what the attachment carries after binding succeeds.

```ts
/** Computed once per reactivation. Consumed blindly downstream. */
interface ReactivationPlan {
  strand: StrandId;                 // taskId — replay scope (per-strand rule)
  placement: Placement;             // pin + route + evaluatorKind + epoch
  epoch: EpochNumber;               // reclaimed lease era
  sandbox: SandboxIntent;           // reuse candidate from affinity
  expiry: ExpiryPolicy;             // R5′ inputs
}

/** Issued at bind: the plan plus what binding minted. */
interface Mandate extends ReactivationPlan {
  addressing: Addressing;           // sessionId/turnId/taskId — private to spine
  programCapability: ProgramCapability;
}
```

Open question resolved structurally: plan and mandate are two stages of one
role, not two roles. Naming stays `Mandate` for the carried form.

## 3 · Attachment birth — the replay walker (Invariant W)

```ts
type WalkerMode = "cold-walk" | "warm-proof";

/**
 * Pure with respect to interactions: no commands, no venue fires, no
 * capability spends, cannot park (Invariant W). Reads its own strand only.
 */
interface ReplayStrategy {
  run(mandate: Mandate, strand: StrandStream): Operation<FrontierProof>;
}
```

Contract: ends only at `frontier == head` or invariant breach (digest chain
failure ⇒ journal violation, not retryable). Counters are owned here; the
live edge resumes at the terminal index.

### Ports and middleware — where strategy plugs in

Strategy selection is Effection DI through the foundation Port mechanism
(ADR-004), not parameters on free functions. Drivers install into the
activation scope at bind time, chosen by mandate fields; `seal()` follows.
Because `installDriver` mounts at `min`, host-provided middleware at the
default `max` position always surrounds every driver regardless of
installation order.

```ts
export const ReplayPort = definePort("spine.replay", {
  *run(mandate: Mandate, strand: StrandStream) {
    /* fail-closed default: throw placement_unavailable */
  },
});
// drivers: ColdWalkStrategy · WarmProofStrategy — installed by plan.sandbox

export const DeliveryPort = definePort("spine.delivery", {
  *deliver(delivery: Delivery, peer: PeerEndpoint) {
    /* default: throw peer_unavailable */
  },
});
// drivers per transport wire; middleware stamps correlators,
// applies retry/backoff, maps failures to foreign_reference_lost outcomes

export const ExpiryPort = definePort("spine.group.expiry", {
  *deadline(group: ForkGroupRef) { /* policy source, R5′ */ },
});
```

Middleware rides these APIs for cross-cutting concerns: digest-chain
verification and progress around replay; correlator stamping and loss
mapping around delivery. This also gives the deferred
settlement-observation thread its native shape — the `afterResolve`/
`acknowledge` unification is settlement middleware, not a new interface.

Division of labor, stated as a rule:

> **Ports vary mechanism inside the rules; the registry defines the rules'
> vocabulary; the kernel enforces the rules.**

So kinds and venues stay registry *data* — deliberately not ports. A
scope-injectable venue would let composition mint interaction semantics
mid-flight, which the freeze discipline exists to prevent.

## 4 · Live edge

```ts
/** Split along the phase boundary — `resolved` is unrepresentable here. */
type LiveReservation =
  | { status: "authorized";
      pullId: PullId; attemptId: AttemptId;
      resolutionCapability: ResolutionCapability }
  | { status: "pending"; reason: PendingReason };   // elicit|wait|child|foreign|sample

/** Venue is data (registry), not a subsystem. Emission rides as "append". */
type Venue = "attempt" | "append" | "transport" | "host" | "world";

/** Steps shrink to two shapes once emission is an interaction. */
type Step =
  | { type: "interaction"; actionIndex: ActionIndex;
      descriptor: DurableOperationDescriptor }
  | { type: "terminal";
      outcome: TerminalOutcome };        // completed | failed | cancelled
```

Settlement surface (host/world venues) and `onPark` adjudication keep their
existing shapes; `onPark` remains the flagged rename candidate.

## 5 · Delivery — the entire peer_hosted delta

```ts
/** Journal-first, then deliver. At-least-once toward the peer. */
interface Delivery {
  correlator: PullId;                // peers SHOULD dedupe per correlator
  payload: OutcomeJson | ElicitAnswer | SampleResult;
}

type DeliveryResult = "delivered" | "peer_lost";
// peer_lost resolves the parked pull with an errored outcome
// (foreign_reference_lost class); authored code moves on. Evidence written
// by peers enters strands as opaque attributed records — never recipe.
```

`crank_native` children have no delivery step: the strand is the shared
medium. This interface is the whole R6′ surface difference.

## 6 · Call stacks

### A — one message, end to end (upstream → spine → downstream)

```
UPSTREAM ─────────────────────────────────────────────────────────
inbound message            conversation transport receives the reply
conversation head          idle → active · logical turn bound
router                     targets slot S1 on the advancing leaf
                           (R4′: leaf set queried from forest.rows())

SETTLEMENT
  resolve(S1, answer)      ✦ participant capability spent
  kernel                   command → five decision stages → transition
  COMMIT LOOP              applies the transition:
                             STORAGE WRITE — strand G += record g3,
                             offset assigned here; frontier advanced;
                             forest row updated
  receipt                  {resolutionOffset · outcomeDigest} → caller

SPINE ────────────────────────────────────────────────────────────
onPark(group)              picks the advancing leaf (R1′ order)
lease.reclaim(epoch+1)     fenced single writer again
plan = compute(...)        forest read-model + affinity + expiry inputs
mandate                    issued at attachment bind
REPLAY walker
  strand stream            ← STORAGE READ: segmented records,
                             taskId-partitioned, offset-ordered
  feed committed outcomes  no commands · no venues · cannot park
  bind frontier (+proof)   warm-proof skips the stream when valid

LIVE EDGE — every interaction below touches storage twice:
  reserve<K>(descriptor)   kernel command → STORAGE WRITE (intent record)
                           authorized ✦ resolutionCapability minted
  venue gate (registry data):
    attempt   handler performs inline
              resolve ✦ → kernel → STORAGE WRITE (commitment)
    append    emit → STORAGE WRITE (emission record, offset)
              acknowledge(offset)
    transport DeliveryPort.deliver(correlator) ✦ → STORAGE WRITE
              peer_lost → errored outcome → STORAGE WRITE
    host/world pending → PARK
step.terminal:
  closure(complete-task)   ✦ programCapability spent
                           STORAGE WRITE — TaskClosed record
  disposition declared · lease released

DOWNSTREAM ───────────────────────────────────────────────────────
projection                 folds forest rows + strand records → events
                           (reads through the journal contract —
                            never the store directly)
snapshot export            background: authority state → snapshot codec
                           → persisted for fast cold-start recovery
peer deliveries            correlator-tagged, at-least-once
                           (peer_hosted leaves only)
conversation head          leaf set empty ⇒ active → idle
```

### B — delegated sample from a peer_hosted leaf (MAY path)

```
UPSTREAM    peer requests sampling ──(delivery, inbound)──► host
SPINE       host journals DelegatedInteraction{attribution, pull}
              in PARENT strand                      ← STORAGE WRITE
            reservation → authorized → sample venue
            model-runtime settles ✦receipt          ← STORAGE WRITE
DOWNSTREAM  outcome delivered(correlator) back to peer
Peer never touches the journal; host-metered because delegated.
```

### C — peer loss at delivery

```
SPINE       delivery → peer_lost
            resolve(pullId, error{foreign_reference_lost}) ✦
              → STORAGE WRITE (errored commitment)
            live edge resumes: authored failure is data
            (move on | terminate)
DOWNSTREAM  group may still hold other leaves; expiry unaffected;
            projection renders the failed interaction as history.
```

### Where storage fits

Storage is **not** a Port and carries no spine vocabulary. It is the
shell's state strategy beneath the kernel contract — `crank_native`
semantics over either a memory strategy or a segmented persistent store.
The kernel contract (`command` / `query` / `journal` / `snapshot`) is the
only door: drives, venues, walkers, and projections never see the store.
Segmentation exists to serve exactly one customer named in this document —
the replay walker's streamed reads.

## 7 · Naming decisions these types force

1. **leaf** — `onPark` must name what it picks (`pickAdvancingLeaf()` reads
   naturally; `pickAdvancingTaskHead()` does not). Recommend ratifying leaf.
2. **handoff** — `frontier == head` boundary needs a verb-name if it ever
   becomes observable; stays free until then.
3. **venue** — promoted de facto by `Venue` appearing as a registry field;
   recommend adopting.

## 8 · Explicitly unchanged

Journal record schema · snapshot codec · capability/audience grammar ·
kernel decision stages · projection inputs. The durability class changes
*interpretation* at exactly three points (§5, §2 sandbox intent, R5′ policy),
which is the encapsulation claim R6′ made — now stated as types.
