# Node SQLite journal

`createSqliteJournalStore<R, Q, V, E, S, Y>({ database, id, program, equals,
serialization })` binds the shared durable journal implementation to a caller-owned
Node `DatabaseSync` connection. `store.open()` starts fresh projection bindings;
reopen a connection with the same root `id` and pinned `program`, then rebind owned
calls through `ensureChild`. Root creation is lazy at the first journal operation.
Caller owns connection disposal and must not wrap these operations in another
transaction on the same connection.

`serialization` is an existing scoped API facade with
`resolve(): Operation<Serializer, Y>`. There is no new serializer helper framework.
Resolution runs before `BEGIN IMMEDIATE`; it may suspend. Current authority and
ownership are read after the lock is acquired, so cancellation or replacement that
wins during resolution fences the later settlement. Encoding and the decision do
not suspend inside the transaction. Errors roll back all uncommitted records. After
COMMIT, the shared transaction interpreter runs registered local publications
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
