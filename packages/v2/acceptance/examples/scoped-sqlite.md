# Scoped synchronous SQLite consumer

The [assembly](./scoped-sqlite.ts) declares the existing `SqliteConnection` as a
grouped core API with the connection in `sync`. It adds no local dispatcher,
lifetime guard or middleware registry. Consumers install `around({ sync: { run: next => wrappedRun } })`,
then acquire `const sql = yield* api` before constructing the journal. SQL calls resolve policy
synchronously inside the transaction.

[Acceptance](../__tests__/applications/scoped-sqlite.acceptance.test.ts) runs real
in-memory Node SQLite under Effect and Effection. It proves middleware ordering,
child driver isolation, retained parent scope selection, parent restoration, fresh
root isolation, and rejection after scope exit or cancellation. Throws and invalid
Promise/operation returns after a SQL write roll back admission and activation intent;
the same database subsequently accepts admission. This covers statement failures
inside the transaction, not transaction middleware throwing after `next` has committed. The caller owns database disposal.

The acquired handle resolves its captured scope's current policy on each call.
This differs from the preceding acquisition experiment, which snapshotted wrappers.
The generic `transaction<T>` method keeps its signature on the synchronous handle.
The journal's existing non-yielding transaction runner remains unchanged.

Return guards cannot cancel already-started async work or undo external effects.
Middleware must remain synchronous; the SQL driver owns callback and commit semantics.
This is evidence for composition and rollback on Node SQLite, not process-crash
survival or a new deployed Cloudflare guarantee. Workerd journeys continue to exercise
the existing journal/host adapters separately.

See [Runtime composition](../../runtime/COMPOSITION.md) for the grouped method,
property and captured-scope contracts.
