# @sweatpants/storage-postgres

Postgres implements the shared journal and conversation kernel using real
transactions and authority advisory locks. Immutable insert races roll back the
whole mutation and replan against the winning rows, so a committed result always
names records actually stored. Conflicting content yields an immutable conflict;
identical replay adopts the existing record.

`initialize: true` applies checked-in Drizzle migrations (the default when opening
Postgres storage). Run `pnpm db:generate` here after changing `src/schema.ts`.
During prerelease, reset databases and regenerate a fresh baseline whenever
needed. This tooling does not introduce a legacy-data compatibility policy.

The domain schema matches SQLite and D1. Structured payload columns use native
Postgres JSONB; counters use BIGINT with decimal-string driver mapping so values
above JavaScript’s safe integer limit retain precision. Shared row mappers pass
structured values directly to Drizzle without an intermediate byte encoding.
Execution objects contain JSON rather than inline binary artifacts.

Terminal JSONB payloads must fit the 16 MiB scan ceiling in PostgreSQL’s JSON text representation. A database check rejects larger values transactionally, including numeric notation that JSONB expands beyond its compact input form.
