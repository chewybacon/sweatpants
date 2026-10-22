# Remaining platform confidence matrix

Public authoring, tool-loop, validation, concurrency, stale-response, provider
failure, durable replay/cancellation, host replacement and worker failure cases
have moved to [`acceptance/COVERAGE.md`](../../acceptance/COVERAGE.md). That
ledger maps removed cases to passing replacements and records runtime/storage
coverage. The single public command is `pnpm test:acceptance`.

This package retains independent guarantees that have not been ported:

- Exact streaming/journal policy and wire projection, including multimodal data.
- Public message ordering, history paging and bounded conversation windows.
- Conversation command admission and storage-client APIs.
- Stream reconciliation and nested tool ownership.
- Standard agent/model placement and MCP continuation contracts.
- Graceful shutdown and cross-process SQLite storage-spine correctness.
- Authoring-style checks for the remaining scenario-based tests.

The remaining package lanes collect 43 memory, 14 SQLite and nine process
cases. Backend/process lanes retain their real boundaries. Low-level storage,
fencing, serialization and concurrency conformance also remains package-owned.
