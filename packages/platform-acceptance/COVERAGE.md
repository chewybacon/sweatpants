# Remaining platform confidence matrix

Public authoring contracts live in [`acceptance/COVERAGE.md`](../../acceptance/COVERAGE.md).
That ledger maps removed cases to replacements and records runtime/storage
coverage. The single public command remains `pnpm --filter @sweatpants/acceptance test`.

This package retains distinct guarantees:

- Provider wire projection, structured response handling, malformed-argument
  normalization, capability rejection and thinking settings.
- Multimodal durability, finite windows, active stream lifecycle replay and
  bounded conversation-source recipes.
- Nested child ownership, model-sampling placement and MCP worker exchange.
- Authoritative stream reconciliation and caller-owned SQLite storage clients.
- Graceful shutdown and cross-process SQLite storage-spine correctness.
- One executed product facade golden path and scenario-authoring checks.

The lanes now collect **28 memory, two SQLite and nine process cases**.
Generic binding matrices use HTTP once; in-process mounting and model-placement
still have focused coverage. SQLite owns the two multi-turn timeline cases
(ordinary worker tools and durable tools); memory does not rerun those cases.
The nine process cases, storage-client API, storage-adapter conformance, and
central SQLite replacement/SIGKILL tests retain persistence boundaries.

Removed history, streaming/journal and admission suites are covered by stronger
assertions in the existing central React and command-retry cases. Their two
plain-text sends, exact delta sequence, stable assistant ID, protocol ordering,
private-text exclusion, causal tool history, one durable text emission, and
server-side parked admission rejection are tested without extra scenarios.
The old symbol-only facade smoke was redundant with strict imports and the
executed golden path; its awaited Effection operation did not execute the setup.
No behavioral golden-path assertion was removed.
