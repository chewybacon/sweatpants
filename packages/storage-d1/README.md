# D1 storage cost contract

D1 charges for rows read/scanned and written, including index maintenance. A
bounded response alone is not a bounded query. This adapter's cost tests run SQL
in local workerd, capture `meta.rows_read` / `meta.rows_written`, and inspect
`EXPLAIN QUERY PLAN` for the executed reads.

Run `pnpm -C packages/storage-d1 test`. The cost suite is also part of `pnpm land`.

## Measured baseline

With 100 and then 10,000 unrelated/pre-cursor records:

| Operation                                                                                  | Rows read | Rows written |
| ------------------------------------------------------------------------------------------ | --------: | -----------: |
| Point lookup, two 3-record deep pages, missing lookup, and one authority creation combined |        27 |            3 |
| Replace an existing inline authority                                                       |        10 |            2 |
| Wait for a journal change                                                                  |         0 |            0 |

32 simultaneous independent authority creations use 32 attempts, 192 reads, and
96 writes; the regression test permits no retries. Shared-alias races still
allow exactly one winner without publishing the losing authority.

Tests enforce upper bounds, including forward/backward cursor seeks, missing
records, authority replacement, and stale writes. SELECT plans must use searches
without full scans or temporary sorts. Results are local workerd measurements,
not a production billing guarantee or a per-chat-turn estimate.

## Query discipline

- Domain records use the same generated tables, unique indexes and structured JSON
  columns as SQLite. `pnpm db:generate` derives the portable baseline from SQLite;
  a parity test prevents schema drift. D1 binds counter text through SQLite integer
  casts and returns integer text, preserving exact counters above JavaScript precision.
- Encoded row bindings up to 1 MiB remain inline. Larger records retain indexed domain
  metadata while their JSON text is stored in ordered physical payload chunks.
  Point reads join the row and chunks in one database snapshot. Missing chunks fail.
- Journal pages seek by domain conversation/task and position indexes. They select
  at most `maxRecords + 1` metadata rows, then fetch only payloads within the byte
  payload budget in groups under D1's 100-parameter limit. Public/private segments
  use their domain payload sizes; terminal entries use SQLite's `octet_length`.
  Overflow manifests retain terminal payload size because the inline JSON column
  is replaced by a placeholder. Root-index metadata is bounded by row count.
  There is no universal record-size column or OFFSET pagination.
- Waits perform no hidden D1 reads. The shared repository reads the head before
  and after the requested wait. This D1 implementation is timeout-based, so a
  cross-host change can take up to that timeout to become visible to a watcher.
  Response streaming has its own DO notifications and is not driven by this wait.
- Initialization creates indexes on a fresh database. Older prerelease local
  schemas must be reset/reprovisioned deliberately; these tests do not certify
  an old database with missing indexes.

## Remaining costs to budget before cloud rollout

Actual traffic still costs money. Replaying a long conversation reads its history;
large records consume multiple chunks. Authority updates replace inline JSON or
rewrite chunks, removing any chunks left by a previously larger value.
Commits validate the authority revision and immutable alias identities
actually read by the mutation. Unrelated writers do not invalidate that snapshot.
A transaction-local token gates subsequent statements inside the atomic D1 batch.
Conflicts on shared identities can still retry, bounded by `maxAttempts` (default
32). That is a correctness retry budget, not a dollar cap. Use production D1 metrics to measure reads and
writes per turn and retry amplification under the intended concurrency before
setting deployment capacity.

The yo-chat thread sidebar separately uses 50-row pages (maximum 100) with
indexed keyset cursors. Its workerd tests measure both global and namespace
queries, including deep pages with identical timestamps: a 10-thread page reads
10–11 rows at both tested sizes. No automatic traversal of older pages occurs.
Restoring a selected older thread uses one primary-key lookup.

No billing alerts, account quotas, or production traffic limits are configured
by this package. Local response stores currently retain streams indefinitely;
DO retention and storage growth require a separate lifecycle policy before a
long-running production rollout.

References: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/), and
[query metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
