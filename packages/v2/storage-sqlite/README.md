# SQLite journal

`createSqliteJournalStore<R, Q, V, E, S, Y>({ connection, id, program, equals,
serialization })` binds the shared durable journal implementation to a caller-owned
synchronous `SqliteConnection`. Two connections are provided:

- `createDurableObjectSqliteConnection(ctx.storage)` from the root entry, using
  `transactionSync` (Durable Objects reject SQL `BEGIN`/`SAVEPOINT`).
- `createNodeSqliteConnection(database)` and `v8Serializer` from
  `@sweatpan.ts/storage-sqlite/node`, using `BEGIN IMMEDIATE` on `DatabaseSync`.

Journal work inside a transaction must not suspend. Asynchronous drivers such as D1
or libSQL do not fit this contract and would need a different transaction boundary. `store.open()` starts fresh projection bindings;
reopen a connection with the same root `id` and pinned `program`, then rebind owned
calls through `ensureChild`. Root creation is lazy at the first journal operation.
Caller owns connection disposal and must not wrap these operations in another
transaction on the same connection.

`serialization` is an existing scoped API facade with
`resolve(): Operation<Serializer, Y>`. There is no new serializer helper framework.
Resolution runs before the transaction begins; it may suspend. Current authority and
ownership are read after the lock is acquired, so cancellation or replacement that
wins during resolution fences the later settlement. Encoding and the decision do
not suspend inside the transaction. Errors roll back all uncommitted records. After
commit, the shared transaction interpreter runs registered local publications
synchronously before returning or allowing
another command in the assembly to begin; losing the caller acknowledgement cannot
replace an already committed projection.

The experimental schema has execution heads, per-request authority rows, and
append-only accepted history indexed by sequence and receipt. There is no schema
versioning or backward compatibility; discard databases from older development
schemas. Current heads contain frontier metadata, not history or growing maps.
Transactions read only the heads and exact request/receipt rows they need. Duplicate
acknowledgements do not write. Child completion and parent acceptance share one
transaction; cancellation fences the active descendant chain before commit.
Ownership across different databases is not supported.

Journal.read returns metadata and a history reader pinned to its accepted frontier.
History pages run outside write transactions and cannot include later appends.
Replay reads pages from zero; checkpoint middleware reads an anchor when needed and
only the suffix. A concurrent mutation makes the eventual activation write stale.
Receipt uniqueness is enforced by storage; recovery checks sequence continuity and
request/scope correspondence as entries are consumed. Format checks happen at the
storage boundary without recursive domain validation. There is no multi-format
reader registry; changing writers requires an explicit representation decision.

## Serializer

`v8Serializer` uses Node's native binary serialize/deserialize with format identity
`node-v8:1`. It supports Map, bigint and typed arrays; unsupported values such as
functions reject encoding. No JSON conversion or domain schema traversal is added.
It is not a guarantee of parity with structuredClone or interoperability with
Cloudflare/other language runtimes. Lua checkpoint reopen is tested on the installed
Node runtime, not across a Node/V8 upgrade matrix.

## Evidence and limits

Hosted acceptance uses real temporary database files under both runtimes. It covers
separate-connection cancellation during serializer resolution, replaced grants,
retained occupancy, duplicate acknowledgement, unsupported format rejection,
parent/child projection and encoding rollback, queued pre-boundary cancellation,
protected cleanup/critical scopes, and reopened Lua replay/restore/fallback.

Authority transactions currently use BEGIN IMMEDIATE, including head reads. History
range reads do not acquire that write lock. The Node driver is synchronous, while
JournalBackend permits adapters to suspend on native async database operations.
No Promise wrapping pretends to make DatabaseSync nonblocking. Future adapters must
preserve isolation/absence checks and rollback across suspension; whole-tree preload
is not required by the port. Native database errors propagate without implicit retries.

No claim is made about OS-crash survival, disk faults, cross-process concurrency,
exactly-once provider IO, or cross-database atomicity. Retained authority and history
still consume space; large individual values/checkpoints remain large. No pruning or
historical branching policy is implied by bounded access.

## Activation intent

`store.activations` exposes root-tree `read`, `request`, and compare-token
`acknowledge` commands. `sweatpants_activations` stores one opaque pending token per
root tree. Journal transactions replace it before COMMIT whenever they introduce
activation-relevant writes, including child replies and cancellation. Failed writes
roll back records and intent together. Recovery-only revision/checkpoint refresh of
an existing pending boundary preserves the token. Acknowledgement is one conditional
DELETE; a newer token from another connection cannot be removed by a stale caller.

Explicit request uses an atomic upsert; reads and acknowledgements do not require
serializing journal payloads. These commands never advance a Guest or authorize
retry. Bind a fresh store after closing a connection. The platform retains root IDs
and arranges discovery/reconciliation; no global scan or background process is
started by this adapter. See [deployment reconciliation](../deployment/README.md).

Acceptance: `hosting/durable-object-journal.acceptance.test.ts` runs a parked
approval in a Miniflare Durable Object under both runtimes, restarts workerd with
persisted storage, answers, and completes without redelivering the executed effect.

## Read-only database inspection

ONI's call inspector needs all episodes and completed child calls in SQLite insertion
order so it can associate calls with preceding model samples. A known-root
`JournalReader` cannot supply database discovery or that cross-execution ordering;
opening the normal store also performs schema setup and uses write transactions.

`createSqliteHistoryReader({ connection, serializer })` is a synchronous adapter
capability for this consumer. It is exported from the package root and the
`@sweatpan.ts/storage-sqlite/inspection` entry, which has no runtime dependency on
writer assembly. Construction performs no IO. `read({ after: 0, limit: 128 })`
returns a bounded page of `{ position, tree, execution, accepted }` records. Pass
its last `position` as `after` for the next page; an empty page is exhausted at that
read. The caller selects page size; it bounds record count, not payload bytes.

Bind an already acquired serializer and a connection exposing `all`. Format identity
is checked before decoding; application payloads remain unknown. No schema creation,
write, execution acquisition or attempt resolution occurs. With Node, open
`DatabaseSync(file, { readOnly: true })`, adapt it with `createNodeSqliteConnection`,
and explicitly own `BEGIN`/`COMMIT` and disposal around a scan when it needs one
consistent snapshot. This does not use the connection's write-transaction helper.
Without a caller-owned read transaction, separate pages may observe later commits.

Positions are SQLite row IDs for this database, not portable journal cursors. They
must not be reused after database replacement, export/import, retention or schema
migration. Insertion order is not external effect completion order or a distributed
timeline. This API reads accepted outcomes only: pending attempts, execution heads,
model/tool decoding, filtering, redaction and reporting remain separate concerns.
It supports the current schema and rejects mismatched serialization formats; it
provides no migration or heuristic decoding of older layouts.

`applications/sqlite-history-inspection.acceptance.test.ts` exercises read-only WAL
snapshot isolation while another connection commits, cross-tree ordering, bounded
pages, reopen and format rejection under both runtimes. ONI's actual inspector
acceptance additionally checks completed children, occupied pending attempts,
round attribution, filtering, redaction and page boundaries. This is in-process
SQLite evidence, not process-crash durability or a live game test.
