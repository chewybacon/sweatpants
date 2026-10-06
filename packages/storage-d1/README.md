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
| Point lookup, two 3-record deep pages, missing lookup, and one authority creation combined |        51 |            5 |
| Replace an existing one-chunk authority                                                    |        14 |            5 |
| Wait for a journal change                                                                  |         0 |            0 |

32 simultaneous independent authority creations use 32 attempts, 160 reads, and
160 writes; the regression test permits no retries. Shared-alias races still
allow exactly one winner without publishing the losing authority.

Tests enforce upper bounds, including forward/backward cursor seeks, missing
records, authority replacement, and stale writes. SELECT plans must use searches
without full scans or temporary sorts. Results are local workerd measurements,
not a production billing guarantee or a per-chat-turn estimate.

## Query discipline

- Point reads resolve composite primary keys; chunk reads stay within that key.
- Journal pages seek by `(collection, index_name, scope, digits, position, key)`.
  They fetch at most `maxRecords + 1` metadata rows, then only the record chunks
  that fit the requested byte budget. There is no OFFSET pagination.
- Waits perform no hidden D1 reads. The shared repository reads the head before
  and after the requested wait. This D1 implementation is timeout-based, so a
  cross-host change can take up to that timeout to become visible to a watcher.
  Response streaming has its own DO notifications and is not driven by this wait.
- Initialization creates indexes on a fresh database. Older prerelease local
  schemas must be reset/reprovisioned deliberately; these tests do not certify
  an old database with missing indexes.

## Remaining costs to budget before cloud rollout

Actual traffic still costs money. Replaying a long conversation reads its history;
large records consume multiple chunks; an authority update rewrites its chunks.
Optimistic commits validate the authority revision and immutable alias identities
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
