# flowmode-backend

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: adapt a language kernel to the shared program attachment,
binding resolution, and journal-backed execution path.

Current owner: [program-backend-kernel](../program-backend-kernel/src/index.ts).
Promotion must migrate that package and its consumers in one change, preserving
the existing ProgramDriver and authority checks. It must not introduce a parallel
driver, storage authority, or execution lifecycle.

Readiness evidence: accepted-effect recovery, binding and identity validation,
checkpoint provenance, cancellation, and existing Execution consumer acceptance.
Incremental pending-set reconciliation for scoped tasks remains unfinished work.
