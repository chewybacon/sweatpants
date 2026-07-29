# Bounded durability — protocol and port hygiene

## Commit

- `4c8429d` — pin replay-only ProgramDriver metadata, remove the duplicate driver subpath, convert authored Promise ports, and add charter gates.

## Changes

- `ProgramDriver.capabilities` is mandatory.
- Local, worker, AgentCore, and A2A ProgramDrivers explicitly publish `{ replay: { kind: "replay", version: 1 } }` and no continuation capability.
- The optional continuation capability has an explicit version/format discriminant and a conformance test proving mandatory replay remains unchanged.
- Deleted the duplicate `durable-execution/program-driver` implementation/export/build entry. The canonical protocol identity is `program-driver-contract.ts` through the package root.
- Converted Tool Session's `DurableIdempotencyStore` from Promise methods to Effection Operations.
- Converted Agent Host remote-executor, standard-agent, and peer connection APIs from Promise results to Operations; external discovery/fetch Promises are adopted immediately with `call`.
- Added repository tooling tests for Journal Authority, History Store, Chat Core, and Durable Execution package charters.
- Added a static authored-port gate over the canonical authority/store/program/workspace/connection contract files.

## Evidence

- Production and test typechecks passed across 24 packages.
- Tooling: 14 passed.
- Durable Execution: 25 passed.
- A2A: 48 passed, one explicitly live-only skipped.
- Tool Runtime Local: 39 source + 6 acceptance passed.
- Tool Runtime AgentCore: 44 passed.
- Workspace Runtime: 18 passed.
- Agent Host: 37 passed.
- Package graph: 25 packages, zero package/module cycles and zero violations.
- Clean build, export validation, product-surface validation, all package/app suites, yo-a2a Inspector, and deterministic yo-chat E2E passed through `pnpm land`.
- Deterministic landing: 19/19 stages passed in 4m01s.
- Artifact: `.artifacts/landing/2026-07-29T17-03-15-398Z-deterministic/summary.json`.
- Coverage baseline now records 1,249 package tests / 1,221 passed and 14 tooling tests.
