# @sweatpants/storage-sqlite

SQLite conversation and execution durability spine: one authority store for
conversation history and program-driver execution journals, initialized and
validated fail-closed.

## Opening

```ts
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";

// Path mode: the kernel creates, owns, and closes the connection.
const handle =
    yield *
    openBetterSqliteStorage("/var/lib/app/authority.sqlite", {
        initialize: true,
        wal: true,
    });
await handle.close();

// Database mode (binding inversion): the caller owns the connection.
const mine = new Database("/var/lib/app/authority.sqlite");
const adapted =
    yield *
    openBetterSqliteStorage(undefined, {
        database: mine,
        initialize: true,
    });
await adapted.close(); // `mine` stays open — the kernel never closes it.
```

Exactly one of `path` / `database` must be given (`sqlite_storage_binding_conflict`).
Readonly bindings are rejected (`sqlite_storage_binding_readonly`). The kernel
applies its connection discipline (safe integers, foreign keys, WAL,
`busy_timeout ≥ 5000`) idempotently to handed-in bindings.

## Client surfaces

Two access tiers over the same artifact, both read-only:

- **`@sweatpants/storage-sqlite/schema`** (tier 1): drizzle definitions for
  the ten authority tables plus the `sqliteSchema` aggregate. During prerelease,
  schema changes are handled by rebuilding local databases.
- **`@sweatpants/storage-sqlite/client`** (tier 2): `createChatStorageClient(database)`
  for typed, read-only thread and transcript queries, and
  `openChatStorageReader(path)` for out-of-process read-only tools.

Neither tier mutates authority data — writes belong to kernel operations —
and neither adds authorization: filesystem access to the file is the trust
boundary.

## Bounded kernel scans

SQLite and Postgres share domain row codecs and the kernel's page-selection
rules. An indexed seek reads identities, positions, and `stored_bytes` with one
lookahead row. The kernel selects a contiguous page within both the record and
byte limits, then loads its payloads in one batch. D1 uses the same page-selection
rules over its own record metadata. `stored_bytes` counts the complete encoded
kernel record; `encoded_bytes` remains the domain payload size.

The initializer applies the checked-in SQL generated from the Drizzle schema.
Run `pnpm db:generate` in this package after changing `src/schema.ts`. During
prerelease we can reset databases and regenerate a fresh baseline; migration
tracking does not promise compatibility with old local data.

## Co-tenancy

The `sp_` prefix is reserved for kernel-managed objects (tables and indexes).
Application tables may live beside them in the same file under any other
name; kernel validation ignores them. A foreign `sp_*` object fails the open
closed with `sqlite_namespace_collision` and is never deleted or modified.
Write co-tenant rows through your own connection; the kernel binding is
kernel-exclusive for writes.

See `docs/chat-application-configuration.md` in the repository root for the
author-facing guide.
