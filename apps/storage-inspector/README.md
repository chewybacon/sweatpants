# storage-inspector

Read-only local UI for the SQLite durability spine.

## Run

From the `sweatpants` workspace:

```bash
pnpm exec tsx packages/platform-acceptance/src/storage-spine-process.ts producer
SWEATPANTS_STORAGE_SPINE_PATH="$PWD/.tmp/storage-spine/spine.sqlite" \
  pnpm -C apps/storage-inspector dev
```

Open <http://localhost:8120>.

Without `SWEATPANTS_STORAGE_SPINE_PATH`, the inspector reads yo-chat's default
production database at `apps/yo-chat/.data/yo-chat.sqlite`. Set the variable to
inspect any other SQLite file:

```bash
SWEATPANTS_STORAGE_SPINE_PATH=/path/to/database.sqlite \
  pnpm -C apps/storage-inspector dev
```

The API is intentionally read-only. It does not run migrations and does not expose
checkpoint cleanup or other maintenance operations.
