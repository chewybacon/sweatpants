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
