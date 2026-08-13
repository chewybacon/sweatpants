# storage-inspector

Read-only local UI for the SQLite durability spine.

## Run

From the `sweatpants` workspace:

```bash
pnpm exec tsx packages/platform-acceptance/src/storage-spine-process.ts producer
pnpm -C apps/storage-inspector dev
```

Open <http://localhost:8120>.

The inspector reads this database by default:

```text
.tmp/storage-spine/spine.sqlite
```

Use `SWEATPANTS_STORAGE_SPINE_PATH` to inspect another SQLite file:

```bash
SWEATPANTS_STORAGE_SPINE_PATH=/path/to/spine.sqlite \
  pnpm -C apps/storage-inspector dev
```

The API is intentionally read-only. It does not run migrations and does not expose
checkpoint cleanup or other maintenance operations.
