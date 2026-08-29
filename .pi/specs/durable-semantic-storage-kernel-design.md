# Design: Durable Semantic Storage Kernel

## Status

Implemented experimental slice.

The memory and SQLite paths now use the architecture in this memo. PostgreSQL and the explicitly deferred workflow features remain future work. This status records implementation evidence; it does not turn the earlier `durable-conversation-storage-design.md` into a normative contract.

This memo records a design direction that emerged from reviewing the first durable SQLite storage slice. It is not a compliance restatement of `durable-conversation-storage-design.md`. The larger design remains prior research and a source of hypotheses. The SQLite slice exists to test those hypotheses and can justify pivots.

The implemented proof lives in:

- `packages/durable-storage-kernel` for the mutation algebra, validation, middleware seam, memory kernel, and conformance fixtures;
- `packages/history-store` for conversation codecs, pure planners, and the semantic repository;
- `packages/journal-authority` for execution codecs, pure planners, and the semantic repository;
- `packages/storage-sqlite/src/sqlite-kernel.ts` for fixed relational bindings and adapter-owned transactions.

## System statement

**Domain stores observe durable state, use pure planners to describe bounded mutations, and apply those mutations through a small transactional kernel.**

In Elm-style terms:

```text
Model + Message -> Decision + Mutation
```

In storage terms:

```text
observe -> decode -> plan -> apply -> interpret
```

A mutation is immutable data. A transaction callback never crosses the kernel boundary.

## Context

The first SQLite durability slice implemented two durable ports:

- `ConversationStore` for conversation heads, command receipts, checkpoints, public archive segments, terminal history, paging, and head watches;
- `ExecutionStore` for execution control, owner fencing, journal and replay segments, and immutable execution objects.

The slice demonstrated several useful ideas:

- conversation and execution authority can remain separate over one physical database;
- immutable objects plus small mutable control records are practical;
- command admission needs an atomic receipt-and-head transition;
- execution commit needs an atomic segments-and-control transition;
- deterministic identity, CAS, fencing, and fail-closed corruption handling survive process reopen tests;
- database adapters accumulate too much semantic code when memory, SQLite, and later PostgreSQL each implement complete state machines;
- transaction callbacks are awkward across synchronous SQLite, asynchronous PostgreSQL, Effection operations, and middleware;
- backward-linked segments make append and lineage easy but make some bounded read patterns difficult;
- result-oriented parsing applies to complete persisted values and compound invariants, not every scalar field.

The slice is evidence. It is not required to preserve every API or physical representation that it used.

## Goals

- Keep `ConversationStore` and `ExecutionStore` as separate domain-facing ports.
- Share transition, retry, identity, counter, bounds, and immutable-content semantics across memory, SQLite, and PostgreSQL.
- Keep planners pure and independently testable.
- Represent one atomic storage action as a bounded immutable value.
- Let each backend own connection, transaction, rollback, and notification mechanics.
- Support synchronous and asynchronous database drivers without exposing a transaction callback.
- Preserve domain-specific relational tables, indexes, inspection, and retention queries.
- Keep semantic middleware and physical-storage middleware as distinct seams.
- Make normal reads bounded without requiring complete retained-history body materialization.
- Fail closed when selected persisted authority or content is malformed.
- Permit backend optimizations such as PostgreSQL JSONB mutation input without requiring database functions.
- Preserve the four placement axes. The kernel belongs under journal/conversation authority and does not leak into crank or tool execution.

## Non-goals

- Do not build a generic ORM, query language, or database engine.
- Do not merge conversation and execution authority.
- Do not expose the kernel to application or runtime callers.
- Do not make middleware responsible for correctness.
- Do not require one transaction across conversation and execution authority.
- Do not settle response-tail persistence, stop evidence, coordinator recovery, context planning, PostgreSQL deployment, or cleanup automation.
- Do not require a generic physical records table.
- Do not make mutation values public protocol messages, queue items, or workflow journal records.
- Do not preserve standalone segment insertion unless the slice proves a staging use case.
- Do not treat the earlier large durability design as normative where this smaller architecture finds a better shape.

## Architecture

```text
+----------------------------------------------------------------+
| Runtime and application                                        |
|                                                                |
|  ConversationStore API             ExecutionStore API          |
|  domain requests/results            domain requests/results     |
|  semantic middleware                semantic middleware         |
+-------------------------+--------------------------+-----------+
                          |                          |
                          v                          v
+----------------------------------------------------------------+
| Shared semantic repositories                                   |
|                                                                |
|  observe -> decode -> plan -> apply -> interpret               |
|                                                                |
|  conversation planners             execution planners          |
|  complete persisted codecs         complete persisted codecs   |
|  transition invariants             fence/revision invariants   |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| Durable mutation kernel                                        |
|                                                                |
|  read authority       read immutable                           |
|  claim identity       ensure immutable records                 |
|  compare/replace one authority record                          |
|  bounded ordered scan wait-for-change hint                     |
|                                                                |
|  mutation/read middleware                                      |
+-------------------------------+--------------------------------+
                                |
              +-----------------+-----------------+
              v                 v                 v
         Memory kernel     SQLite kernel     PostgreSQL kernel
                           local transaction async transaction
                                             JSONB optimization
```

## Layer responsibilities

### Domain-facing ports

`ConversationStore` and `ExecutionStore` remain the only capabilities used by runtime code.

They expose domain requests and domain results. They do not expose:

- database connections;
- transactions;
- tables;
- raw mutation plans;
- generic record collection access.

The ports remain independently installable and replaceable. One deployment can place them over different kernels. One SQLite or PostgreSQL kernel can also back both.

### Shared semantic repositories

A semantic repository implements a domain store over an explicitly supplied kernel capability.

It owns:

- complete request and persisted-value codecs;
- state-transition validity;
- exact-retry ordering;
- deterministic durable identity;
- semantic bounds;
- revision and fence derivation;
- immutable-content equivalence;
- translation from kernel outcomes to domain results and errors;
- read anchoring and cursor meaning.

It does not own:

- SQL;
- connection checkout;
- transaction lifetime;
- physical integer encoding;
- notification transport;
- migrations.

### Durable kernel

The kernel owns storage mechanics:

- reading and writing declared collections;
- atomic mutation evaluation;
- connection and transaction lifetime;
- rollback;
- physical integer limits;
- bounded scans through declared indexes;
- wake hints;
- physical failures.

The kernel knows claims, immutable records, versions, fences, fingerprints, and collection identities. It does not know idle, parked, terminal publication, command admission, or stale-owner domain results.

### Backend bindings

A backend binds fixed logical collection definitions to physical tables and indexes.

A mutation never contains a raw SQL identifier. An adapter never interpolates an input-selected table name.

Generic APIs do not require a generic schema. SQLite and PostgreSQL can retain domain-specific tables, unique indexes, foreign keys, retention columns, and inspection metadata.

## Core laws

### Law 1: Planning is pure

A planner accepts a request and already-observed values. It returns a decision. It performs no I/O and reads no ambient port or scope.

### Law 2: Mutations are bounded data

A kernel accepts one immutable mutation value. The adapter owns the complete transaction lifetime. Semantic code cannot run a provider, tool, child program, network call, or another port while a database transaction is open.

### Law 3: One mutation has at most one mutable authority target

A mutation can include immutable side records and one compare-and-replace authority record. It cannot mutate conversation and execution authority together.

### Law 4: Exact claims differ from idempotent ensures

A command receipt is a claim. If it already exists, the mutation stops before changing authority.

A checkpoint or segment is an ensure. Equivalent existing content can be reused while the mutation continues.

### Law 5: Conflict is data; broken storage throws

Expected claim, revision, fence, and immutable-content races return structured kernel outcomes. Unavailable, closed, malformed, or transaction-failed storage throws a physical kernel error.

### Law 6: Domain correctness is mandatory, not middleware

Planners and complete codecs implement correctness. Middleware can observe, time, deadline, redact, or deliberately inject test faults. Correct behavior cannot depend on optional middleware.

### Law 7: Notifications have no authority

Every wake or timeout is followed by a durable read.

### Law 8: Cross-authority workflows are recovery protocols

Deterministic identity, idempotent objects, CAS, fencing, and publication evidence connect conversation and execution authority. Physical co-location does not create a stronger cross-store contract.

## Elm-style semantic flow

The architecture adopts Elm's data-and-update discipline without introducing a universal Elm runtime.

A domain operation follows this shape:

```text
request
  -> observe durable values
  -> parse complete values
  -> pure decision
  -> optional mutation effect
  -> mutation outcome
  -> pure/domain interpretation
  -> result or one explicit reload
```

A simple decision type is sufficient:

```ts
type Decision<Result> =
  | {
      readonly kind: "complete";
      readonly result: Result;
    }
  | {
      readonly kind: "apply";
      readonly mutation: DurableMutation;
      readonly committed: Result;
    };
```

Conflict interpretation remains domain code. The generic kernel does not automatically retry a failed CAS. A semantic repository reloads only when the domain operation requires it, such as resolving a command-receipt race.

## Durable mutation algebra

### Shape

```ts
interface DurableMutation {
  readonly claim?: ImmutableClaim;
  readonly ensures: readonly ImmutableEnsure[];
  readonly authority?: AuthorityReplacement;
}
```

A mutation has:

- at most one claim;
- a bounded list of ensures;
- at most one authority replacement;
- a bounded total encoded size;
- unique stable component names;
- only statically declared collection identities.

### Immutable claim

```ts
interface ImmutableClaim {
  readonly name: string;
  readonly collection: ImmutableCollectionId;
  readonly key: DurableKey;
  readonly fingerprint: string;
  readonly value: Uint8Array;
}
```

Semantics:

- if absent, reserve and insert the claim as part of the final atomic commit;
- if present, stop before authority replacement and return the existing claim identity and fingerprint;
- the semantic repository decides whether the existing claim is an exact retry or an identity conflict.

The initial use is a command receipt.

### Immutable ensure

```ts
interface ImmutableEnsure {
  readonly name: string;
  readonly collection: ImmutableCollectionId;
  readonly key: DurableKey;
  readonly alternateKeys?: readonly DurableKey[];
  readonly fingerprint: string;
  readonly value: Uint8Array;
}
```

Semantics:

- absent primary and alternate identities: insert;
- existing primary identity with equal fingerprint: reuse;
- existing alternate identity with equal fingerprint during an ensure-only staging mutation: reuse;
- existing alternate identity with equal fingerprint and the same primary key during authority publication: reuse;
- existing alternate identity with another primary key during authority publication: abort with immutable conflict, so encoded authority cannot select a non-existent primary record;
- any occupied identity with another fingerprint: abort with immutable conflict.

A semantic repository can normalize an already-observed alternate identity before planning an authority publication. Deterministic publication identities normally make this unnecessary. The kernel returns resolved identities for committed ensures.

Initial uses include checkpoints, public archive segments, terminal segments, private journal/replay segments, and execution objects.

### Authority replacement

```ts
interface AuthorityReplacement {
  readonly name: string;
  readonly collection: AuthorityCollectionId;
  readonly key: DurableKey;
  readonly expected: {
    readonly revision: string | null;
    readonly fence?: string | null;
  };
  readonly next: {
    readonly revision: string;
    readonly fence?: string;
    readonly value: Uint8Array;
  };
}
```

The mandatory semantic repository derives next counters. The kernel independently verifies:

- canonical non-negative decimal representation;
- physical range;
- initial counter rules;
- `next.revision` is exactly the current revision plus one;
- a changed fence follows the declared kernel fence rule;
- expected fence and revision match the durable authority row.

Application callers never provide next counters. The shared semantic store derives them.

### Evaluation order

The kernel evaluates a mutation at one linearizable point:

```text
1. Validate mutation structure and physical bounds.
2. Check for an existing claim.
3. Check authority fence, then authority revision.
4. Check immutable ensures in canonical mutation order.
5. Insert the missing claim and ensures.
6. Replace authority.
7. Commit and return resolved records.
```

Steps 2 through 6 are atomic. Any non-committed outcome writes nothing.

This order makes exact command retry precede stale-head checks. It also makes stale owner rejection precede proposed journal-content analysis.

### Truth table

| Claim | Authority | Ensures | Outcome | Writes |
| --- | --- | --- | --- | --- |
| existing | any | any | `claim_exists` | none |
| absent or omitted | fence mismatch | any | `authority_conflict` with `fence` | none |
| absent or omitted | revision mismatch | any | `authority_conflict` with `revision` | none |
| absent or omitted | matches or omitted | conflicting ensure | `immutable_conflict` | none |
| absent | matches or omitted | all absent or equivalent at the selected primary identity | `committed` | claim, missing ensures, authority |
| omitted | matches | all absent or equivalent at the selected primary identity | `committed` | missing ensures, authority |
| omitted | omitted | all absent or equivalent | `committed` | missing ensures |
| absent | omitted | none | `committed` | claim |
| omitted | matches | none | `committed` | authority |

If fence and revision both mismatch, the kernel reports fence mismatch first. If multiple ensures conflict, canonical mutation order selects the reported named conflict.

### Outcomes

```ts
type DurableMutationOutcome =
  | {
      readonly status: "committed";
      readonly authority: StoredAuthorityRecord | null;
      readonly ensured: Readonly<Record<string, StoredImmutableIdentity>>;
    }
  | {
      readonly status: "claim_exists";
      readonly claim: string;
      readonly existingFingerprint: string;
    }
  | {
      readonly status: "authority_conflict";
      readonly authority: string;
      readonly mismatch: "fence" | "revision";
      readonly current: StoredAuthorityRecord | null;
    }
  | {
      readonly status: "immutable_conflict";
      readonly write: string;
      readonly existingFingerprint: string;
    };
```

### Invalid mutations

Invalid mutation structure is a programmer or composition failure. It throws `DurableMutationInvalid` before writes.

Examples:

- malformed or non-incrementing revision;
- malformed fence transition;
- duplicate component name;
- unknown collection;
- too many ensures;
- mutation above byte limits;
- conflicting duplicate identity inside one mutation;
- claim against an authority collection;
- conversation and execution authority in one mutation.

Invalid mutation is not a concurrency result.

## Logical collections

Collection definitions provide typed plan builders and complete codecs.

Conceptually:

```ts
const ConversationHeads = defineAuthorityCollection<
  ConversationId,
  ConversationHeadBody
>({
  id: "conversation-heads",
  key: conversationIdCodec,
  value: conversationHeadBodyCodec,
});

const CommandReceipts = defineImmutableCollection<
  CommandReceiptKey,
  CommandReceipt
>({
  id: "conversation-command-receipts",
  key: commandReceiptKeyCodec,
  value: commandReceiptCodec,
  fingerprint: receiptFingerprint,
});
```

A collection owns:

- logical identity;
- key codec;
- complete value codec;
- canonical encoding;
- fingerprint extraction;
- privacy classification;
- declared ordered indexes, if any.

A collection does not expose a private schema implementation or a SQL table name.

## Complete parsing and validation

Parsing follows the result-oriented parsing design.

Use parsers for complete persisted values and compound invariants:

- stored conversation head;
- command receipt;
- checkpoint;
- public archive segment;
- terminal segment;
- execution control;
- private segment;
- execution object;
- archive frontier or segment range as a meaningful compound value.

Do not create public parsers for individual counters, enum fields, page limits, or single scalar columns. Complete codecs can use small private scalar helpers.

A parser returns `ParseResult<T>` for malformed persisted input. The semantic repository maps one failed complete parse to the owning `ConversationStoreError` or `ExecutionStoreError` at the boundary.

The parser validates semantic content that is common to every backend. The physical adapter validates row representation and database limits.

## Proposed semantic write APIs

The current `ConversationStore` exposes object-by-object assembly followed by head CAS. This prevents a shared semantic layer from choosing one atomic mutation. The semantic port should move toward a conversation commit operation.

### Conversation commit

```ts
interface CommitConversationRequest {
  readonly conversationId: string;
  readonly expectedRevision: DurableCounter | null;
  readonly expectedOwnerEpoch: DurableCounter | null;
  readonly proposal: ConversationHeadProposal;
  readonly publicArchiveSegments?: readonly StoredPublicArchiveSegment[];
  readonly checkpoint?: StoredCheckpoint;
  readonly terminalHistorySegment?: StoredTerminalSegment;
}

type CommitConversationResult =
  | {
      readonly status: "committed";
      readonly head: ConversationHead;
      readonly checkpoint?: CheckpointPointer;
      readonly terminalHistory?: HistoryPointer;
    }
  | {
      readonly status: "head_conflict";
      readonly current: ConversationHead | null;
    };
```

The planner produces:

```text
ensure archive segments
ensure checkpoint
ensure terminal segment
replace conversation head
```

A plain head CAS is a conversation commit with no immutable side records.

### Command admission

Command admission remains separate because it uses claim semantics:

```text
claim command receipt
replace conversation head
```

An existing receipt stops before head mutation. The semantic layer compares command fingerprints and reloads current head when needed for the domain result.

### Execution commit

The landed `commitExecution` already has the correct broad shape:

```text
ensure journal segments
ensure replay segments
replace execution control
```

It should be implemented by a shared planner over the same mutation kernel.

### Staging

Large immutable objects can be staged as an optional optimization:

```text
stage: ensure immutable records only
publish: re-ensure the same records plus authority replacement
```

Staging is not required for correctness. Any staging API must be named `stage`, kept internal where possible, and never imply that a private segment is authoritative before a fenced control commit selects it.

Standalone `appendJournalSegment` and `appendReplaySegment` therefore require a decision:

- remove them;
- make them internal;
- or rename them as explicit staging operations.

## Mapping the landed writes

| Landed behavior | Mutation |
| --- | --- |
| Conversation head CAS | authority replacement |
| Command admission | receipt claim plus head replacement |
| Checkpoint insertion | checkpoint ensure with cause alternate identity |
| Public archive insertion | segment ensure |
| Terminal-history insertion | terminal ensure with publication alternate identity |
| Execution commit | journal/replay ensures plus control replacement |
| Execution object insertion | object ensure |
| Standalone journal/replay insertion | ensure only; staging, not authority |

Every landed write fits claim plus ensures plus at most one authority replacement. No landed write requires an arbitrary transaction callback or multi-authority transaction.

## Read architecture

Writes and reads have different useful abstractions. Reads should not be forced through the mutation algebra.

### Kernel read surface

```ts
interface DurableKernel {
  readAuthority(
    collection: AuthorityCollectionId,
    key: DurableKey,
  ): Operation<StoredAuthorityRecord | null>;

  readImmutable(
    collection: ImmutableCollectionId,
    key: DurableKey,
  ): Operation<StoredImmutableRecord | null>;

  scan(request: BoundedScan): Operation<StoredScanPage>;

  waitForChange(request: ChangeWait): Operation<void>;

  apply(mutation: DurableMutation): Operation<DurableMutationOutcome>;
}
```

### Bounded scans

```ts
interface BoundedScan {
  readonly collection: OrderedCollectionId;
  readonly index: OrderedIndexId;
  readonly scope: DurableKey;
  readonly direction: "forward" | "backward";
  readonly after: DurableCursor | null;
  readonly through?: DurablePosition;
  readonly maxRecords: number;
  readonly maxStoredBytes: number;
}
```

Collections declare permitted indexes. The scan request is not a generic predicate language.

### Semantic read flow

```text
1. Read and decode authority.
2. Read and decode its immutable checkpoint/control anchor.
3. Derive the authoritative snapshot frontier.
4. Run a bounded traversal or scan against that frontier.
5. Decode complete returned records.
6. Validate scope, range, adjacency, hash, and encoded bytes.
7. Return domain values and an opaque continuation cursor.
```

### Cursor anchoring

A continuation cursor must identify its immutable snapshot, not only a numeric position.

Conceptually:

```ts
interface SemanticCursor {
  readonly collection: OrderedCollectionId;
  readonly scopeDigest: string;
  readonly anchorId: string;
  readonly direction: "forward" | "backward";
  readonly nextPosition: string;
}
```

The cursor is opaque outside the semantic repository. It is not an authorization credential.

A later page continues against the same immutable anchor even if the current head has advanced. If retention legitimately removed the old anchor, the caller reloads current authority.

### Physical and semantic bounds

Kernel bounds protect physical work:

- rows;
- stored bytes;
- query duration where supported;
- metadata and body hydration.

Semantic bounds protect domain materialization:

- decoded entries;
- canonical payload bytes;
- legal singleton behavior;
- cursor and envelope size.

Stored byte counts can guide selection, but complete codecs recompute and verify them.

## Segment read strategies

A single segment representation does not need to serve every access pattern.

### Public archive and terminal history

Their primary interactive pattern is recent hot hydration followed by progressively older history.

Backward-linked, newest-to-oldest paging is a good fit:

- first page starts at the selected frontier;
- traversal follows only enough predecessors to satisfy page bounds;
- entries inside one page are returned in chronological order;
- the next cursor identifies the next older page;
- clients prepend older pages.

This excludes orphan segments by construction and avoids complete-chain metadata traversal for normal older-history reads.

### Private journal and replay

Recovery generally needs oldest-to-newest task-local order. Backward links require discovering the complete chain before yielding its first body.

A likely better private read representation is a forward index by:

```text
execution ID + task ID + first/last sequence
```

If private segments commit atomically with execution control, a losing control CAS rolls back segment insertion. Forward scans through the control-selected frontier can then stream task records without materializing sibling journals or the complete task chain.

Standalone segment staging complicates this property and must not silently become visible to scans.

### Orphan visibility

A position scan alone is unsafe when staged immutable candidates from losing publications can share a scope and range. One of these mechanisms is required:

1. traverse reachable metadata from an immutable frontier;
2. page backward from the frontier;
3. publish relational membership/index rows;
4. commit immutable records and authority atomically so losing candidates roll back;
5. mark staged records separately from published records.

The design does not force one mechanism for every collection. It requires each semantic read to select only records reachable from its chosen authority snapshot.

## Integrity scope

A normal page read verifies:

- anchor and scope identity;
- cursor namespace;
- every returned complete record;
- hash and encoded byte count;
- range and adjacency inside the page;
- cursor boundary adjacency;
- selected frontier bounds.

A normal page read does not hash every historical body.

Full retained-history verification belongs to explicit maintenance or inspection tooling. It can verify complete chains, all bodies, all current references, and orphan classification without becoming a runtime storage port.

## Middleware

### Semantic middleware

Semantic middleware wraps `ConversationStore` and `ExecutionStore` operations. It can observe:

- command admission;
- conversation publication;
- checkpoint sizes;
- execution commits;
- head/control conflicts;
- stale-owner results;
- domain operation latency;
- test-scenario probes.

### Kernel middleware

Kernel middleware wraps reads, scans, waits, and mutation application. It can observe:

- transaction time;
- query time;
- record and byte counts;
- connection failures;
- before-commit and after-commit fault points;
- rollback;
- redacted mutation fingerprints.

It must not log persisted bodies or private content by default.

### Planner tests

Pure planners need no middleware or installed scope. They use direct input/output tests and transition tables.

## Error taxonomy

### Semantic concurrency results

Expected races remain returned values:

- head conflict;
- state conflict;
- command identity conflict;
- idempotent retry;
- control conflict;
- stale owner.

### Domain storage errors

The owning semantic store reports:

- immutable object conflict;
- malformed persisted domain data;
- checkpoint bound exceeded;
- segment entry too large.

### Physical kernel errors

The kernel reports:

- connection unavailable;
- transaction failed;
- storage closed;
- physical integer overflow;
- schema incompatible;
- malformed backend response.

A physical outage must not be mislabeled as persisted-data corruption. A malformed persisted domain record must not be returned as ordinary absence.

## Backend designs

### Memory

Memory implements the kernel, not separate conversation and execution semantics.

```text
shared planners + memory kernel = memory semantic stores
```

The memory kernel is the executable reference for mutation evaluation order, atomic rollback, claims, ensures, CAS, and bounded scans.

### SQLite

The SQLite kernel owns:

- application-owned connection integration;
- schema binding and migrations;
- canonical text and BLOB representation;
- serialized writer queue;
- `BEGIN IMMEDIATE` transactions;
- rollback and close lifecycle;
- bounded queries;
- local wake hints or bounded polling.

`apply(mutation)` evaluates the complete bounded mutation inside one adapter-owned transaction. SQLite code does not implement conversation or execution transition state machines.

### PostgreSQL

The first PostgreSQL kernel can use an adapter-owned asynchronous transaction with several internal SQL round trips. The caller still makes one kernel `apply` operation and never receives a transaction handle.

A later optimization can submit mutation metadata as JSONB:

```sql
-- Illustrative only.
SELECT ... FROM jsonb_to_record($1::jsonb);
```

or use one fixed adapter-owned data-modifying CTE statement.

Large binary bodies can travel as separate `bytea` parameters or arrays referenced from the JSONB metadata. Durable 64-bit counters remain decimal strings in JSON.

Database functions are not required. A stored function is justified only if:

- claim/CAS branching is materially clearer in PL/pgSQL;
- round trips are measured as significant;
- the mutation algebra has stabilized;
- deployment and conformance costs are accepted.

If introduced, a function implements only the generic mutation algebra. It does not know conversation states or execution semantics.

## Fault semantics

| Failure point | Durable result |
| --- | --- |
| Before `kernel.apply` | no writes |
| During mutation evaluation | rollback; no writes |
| During insertion or authority replacement | rollback; no writes |
| After commit before response | committed state; semantic retry resolves through claim, ensure, or CAS behavior |
| During committed-result decoding | state may be committed; caller retries semantically |

A lost command-admission response resolves through the receipt claim. A lost immutable-write response resolves through equivalent ensures. A repeated plain CAS conflicts and requires current-state interpretation. A repeated execution commit with the old revision returns current control conflict unless a future design adds an execution-commit claim.

## Package ownership

A possible package layout is:

```text
packages/durable-storage-kernel
  logical collection definitions
  mutation algebra
  kernel contract
  memory kernel or testing implementation
  kernel conformance kit

packages/history-store
  conversation records and complete codecs
  conversation planners
  semantic ConversationStore over a kernel
  conversation conformance kit

packages/journal-authority
  execution records and complete codecs
  execution planners
  semantic ExecutionStore over a kernel
  execution conformance kit

packages/storage-sqlite
  SQLite kernel
  logical-to-physical collection bindings
  schema and migrations
  inspection and documented maintenance SQL

packages/storage-postgres
  PostgreSQL kernel
  logical-to-physical collection bindings
  schema and migrations
  documented maintenance SQL
```

The exact package split is not decided. The ownership boundaries are load-bearing:

- kernel packages cannot depend on conversation or execution semantics;
- history-store cannot depend on SQLite or PostgreSQL;
- journal-authority cannot depend on SQLite or PostgreSQL;
- storage adapters can depend on the kernel contract and logical collection bindings, but not runtime/crank/tool packages;
- application code installs only semantic stores.

## Test strategy

### Planner tests

Pure tests cover:

- complete state-transition tables;
- exact retry precedence;
- deterministic identity;
- counter derivation;
- owner assign, preserve, and clear behavior;
- fence/revision ordering;
- proposal and control validity;
- checkpoint and segment bounds.

### Kernel conformance

The same kit runs against memory, SQLite, and PostgreSQL:

- existing claim short-circuits authority replacement;
- failed authority guard inserts nothing;
- equivalent ensure continues;
- conflicting ensure aborts;
- rollback leaves no partial records;
- fence and revision mismatches remain distinguishable;
- committed result reports resolved identities;
- scans obey row and stored-byte limits;
- close and unavailable behavior fail explicitly.

### Semantic-store conformance

The same semantic store suites run over each kernel:

- conversation creation and CAS;
- command admission and retries;
- immutable checkpoint/archive/terminal identity;
- page cursor and frontier behavior;
- execution commit and stale owner;
- object integrity;
- bounded task-local reads.

### Backend fault and process tests

Backend-specific tests cover:

- crash before commit;
- crash after durable commit before response;
- reopen;
- concurrent writers;
- unsafe physical counters;
- corrupt rows;
- transaction rollback;
- use after close;
- missed wake notification;
- migration/startup behavior.

### Cross-store acceptance

Cross-authority workflows remain causal acceptance tests. They cover publication and recovery protocols without requiring a shared transaction.

## Incremental proof plan

This was the proof order used for the implemented memory and SQLite slice.

1. Define the mutation algebra and a memory kernel.
2. Run kernel truth-table conformance against memory.
3. Implement command admission with a pure planner over the memory kernel.
4. Run existing command-admission behavior against the new semantic store.
5. Implement execution commit with a pure planner over the same kernel.
6. Test claims, ensures, CAS, fence precedence, and rollback under races.
7. Move immutable checkpoint, archive, terminal, and object writes to ensures.
8. Define cursor anchoring and one bounded read strategy per collection family.
9. Implement the SQLite kernel and rerun semantic conformance unchanged.
10. Compare the new path with the current SQLite slice before removing old repositories.
11. Add PostgreSQL only after the kernel algebra and SQLite behavior stabilize.
12. Optimize PostgreSQL with JSONB single-statement application only after measurement.

At every step, retain an outside-in behavioral test. Do not rewrite acceptance expectations merely to fit the new architecture.

## Design decisions

### Decision 1: Generalize storage mechanics, not domain semantics

Conversation and execution planners remain explicit domain code. The kernel generalizes claims, immutable ensures, CAS, scans, and transaction ownership.

### Decision 2: Use mutation values instead of transaction callbacks

This keeps transaction lifetime inside adapters and works across synchronous SQLite, asynchronous PostgreSQL, memory, Effection operations, and middleware.

### Decision 3: Keep semantic ports and make the kernel private

Runtime code consumes domain APIs. Kernel access is an explicit construction capability held only by semantic repositories and storage composition.

### Decision 4: Limit one mutation to one authority target

This prevents a generic transaction DSL and preserves independent conversation and execution serialization domains.

### Decision 5: Distinguish claims from ensures

Exact command retry must stop before a second authority transition. Equivalent checkpoint or segment content can be reused while publication continues.

### Decision 6: Move conversation publication toward one semantic commit

Object-by-object `put` methods plus head CAS expose physical assembly. A conversation commit can plan immutable side records and one head transition together while still permitting explicit staging as an optimization.

### Decision 7: Treat standalone segment insertion as staging unless selected by control

An immutable segment is not authoritative merely because its row exists. A fenced control or checkpoint frontier selects authoritative content.

### Decision 8: Do not force one read representation onto every history

Public/terminal older-history paging can follow backward frontiers. Private recovery can use forward task sequence scans. Both remain behind semantic read APIs.

### Decision 9: Parse complete persisted values

Result-oriented parsing applies to meaningful boundary objects. Scalar field helpers remain private implementation details.

### Decision 10: Do not require PostgreSQL functions

Start with adapter-owned transactions. JSONB statement or stored-function execution is a backend optimization after the mutation algebra stabilizes.

## Resolved questions

The approved [SQLite production storage cutover specification](../../../.pi/specs/sqlite-production-storage-cutover-spec.md) resolves the former open questions in REQ-023 through REQ-031:

1. Counters exist in kernel metadata only. Domain codecs validate complete domain values, and inspection joins metadata to content.
2. Alternate immutable identities use explicit per-collection fixed bindings. The kernel has no generic alternate-key constraint language.
3. Checkpoint, archive, terminal, and head publication commit in one bounded semantic mutation. Staging requires a later measured design.
4. Public and terminal pages are newest-first backward pages anchored at a pinned frontier. There is no second oldest-first public API.
5. Journal and replay segments commit atomically with their fenced control transition. There is no standalone private-segment staging API.
6. Each adapter owns hand-written fixed physical bindings. The kernel does not define an ORM or declarative table mapping.
7. A future PostgreSQL adapter starts with adapter-owned asynchronous transactions. JSONB single-statement or stored-function execution requires measurements and separate approval.

## Relationship to prior designs

`durable-conversation-storage-design.md` remains valuable research on bounded checkpoints, archive authority, command receipts, owner fencing, recovery, and cross-store publication. This memo deliberately narrows and revisits its implementation assumptions.

In particular:

- the larger design's domain behaviors are hypotheses to test against the semantic planner layer;
- the SQLite slice does not need to implement every larger-design feature;
- stop evidence, tails, complete recovery, and PostgreSQL are deferred rather than scored as missing;
- linked immutable segments are reconsidered by access pattern;
- separate object writes before head CAS are not mandatory when one bounded semantic mutation is clearer;
- no cross-store transaction remains a strong architectural boundary.

The result-oriented parsing design remains authoritative for parser mechanics. This memo applies that pattern to complete persisted records and domain-owned boundary errors.

## Success criteria for the architecture experiment

The architecture is successful if the proof shows:

- memory and SQLite share semantic planners rather than duplicate transitions;
- command admission and execution commit use one small mutation algebra;
- adapters own complete transaction lifetime without callbacks;
- kernel conformance is backend-independent;
- semantic conformance runs unchanged over memory and SQLite;
- normal history reads perform bounded body hydration;
- corruption remains fail-closed;
- physical errors remain distinct from domain corruption;
- the SQLite adapter becomes mostly schema binding, transaction mechanics, scans, and lifecycle;
- no generic query or transaction language emerges;
- no runtime code can bypass semantic stores through the kernel.

The experiment should pivot or stop if satisfying current operations requires arbitrary predicates, multiple mutable authority records, dynamic SQL identities, or adapter-specific domain transitions.
