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
not suspend inside the transaction. Errors roll back all affected records.

Schema version 1 stores one encoded execution header (including authority, links
and queued stops) per execution and separate append-only accepted history rows.
A transaction lazily decodes each touched execution and its history once, caches
that decoded view for the decision, then encodes only dirty headers and new history
entries. It does not rewrite historical payloads or round-trip acknowledgements.
Child completion and parent acceptance share one SQLite transaction; cancellation
fences the eligible descendant chain before commit. Ownership across different
databases is not supported.

The schema/format checks are storage-boundary checks, not recursive validation of
trusted domain values. Unknown versions/formats reject. There is no migration or
multi-format reader registry yet. Changing writers without support for previous
stored formats makes those rows unreadable.

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

Reads currently use BEGIN IMMEDIATE too. A touched execution's full history is
loaded, and its authority maps are encoded with its header; historical rows are
append-only, but reads and header size can still grow with history/attempt count.
Selective authority queries and read-only transaction modes remain optimizations.
No claim is made about OS-crash survival, disk faults, cross-process concurrency,
exactly-once provider IO, or cross-database atomicity. SQLite lock errors propagate;
the adapter does not automatically retry provider effects.
