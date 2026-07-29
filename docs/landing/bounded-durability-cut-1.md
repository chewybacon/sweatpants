# Bounded durability closure — Cut 1 landing record

## Commits

- `e6e7d28` — generic role-parameterized descriptor mechanics; removed Foundation's closed role algebra and registry-entry alias.
- `c43e018` — durable-effects, durable-execution, and Agent SDK domain role refinements.
- `c929762` — Journal Authority runtime schema registry and Tool Session foreign contract/adapter switchover.
- `9f4d6c4` — program-contract consumer switchover to durable-execution.
- `2e486ef` — final effect/model-sampling/ProgramRuntime identity switchover and deletion of old Session Contract declarations and implementations.

## Moved and deleted paths

- `session-contract/schema-registry*` → `journal-authority/schema-registry*`.
- `session-contract/testing/schema-fixtures.ts` → `journal-authority/schema-fixtures.ts`.
- `session-contract/model-sampling-*` and `program-placement-context.ts` → `durable-effects/model-sampling-*`.
- `session-contract/purity-scan.ts` and program/error identity tests → `durable-execution`.
- `foundation/schema-descriptor.ts` → the final target subpath `foundation/schema.ts`; the old export subpath was removed without a forwarder.
- Deleted Session Contract `authoring.ts`, `canonical.ts`, `types.ts`, `durable-types.ts`, `durable-contract-types.ts`, `durable-authoring-types.ts`, `durable-protocol-types.ts`, `program-driver.ts`, `program-identity.ts`, schema files, model-sampling files, and their obsolete exports.

## Production and residue searches

```text
rg DurableSchemaRegistryEntry packages apps                       => 0
rg PortableSchemaRole packages apps                               => 0
rg foundation/schema-descriptor packages apps                     => 0
session-contract production export overlap with
  foundation/durable-effects/durable-execution/journal-authority  => 0
createDurableEffectRegistration declarations outside owner        => 0
foundation closed domain-role strings in production               => 0
@sweatpants/session-contract imports from the five Cut 1 hubs      => 0
```

`validate-module-graph` reports 26 packages, zero package cycles, zero architecture violations, and only the two pre-existing Framework module cycles assigned to Cut 3. No alias, compatibility subpath, forwarding package, or duplicate runtime identity was retained.

## Narrow evidence

- Foundation: 35 tests passed; package typecheck passed.
- Durable Effects: 3 tests passed, including the canonical scoped registry identity; package typecheck passed.
- Durable Execution: 23 tests passed, including program identity, context, protocol conformance, checkpoint, transition, and error identity; package typecheck passed.
- Journal Authority: 11 tests passed, including four registry-boundary tests; package typecheck passed.
- Session Contract authority shell: 72 tests passed after old program/effect/schema path deletion; package typecheck passed.
- Agent SDK: 148 tests passed.
- A2A: 48 passed and one explicitly live-only test remained skipped; package typecheck passed.
- Tool Runtime Local: 39 source tests plus 6 acceptance tests passed; package typecheck passed.
- Tool Runtime AgentCore: 44 tests passed; package typecheck passed.
- Framework focused crank/model-sampling/local-host tests passed; the complete Framework suite passed in deterministic landing.

## Graph, exports, clean build, and application evidence

- `pnpm verify:clean-build` passed after deterministic reviewer-artifact regeneration.
- `pnpm check` passed.
- `pnpm check:tests` typechecked tests in 25 packages.
- `pnpm check:apps` passed for all declared applications.
- `pnpm validate:exports` passed for 26 packages.
- `pnpm validate:product-surface` passed (14 facade paths, two product apps, one golden suite).
- `pnpm validate:module-graph` passed with zero package cycles and zero architecture violations.
- Repository format and lint gates passed; lint reported warnings only and zero errors.

## Deterministic landing

`pnpm land` passed all 19 stages in 3m14s.

- Artifact: `.artifacts/landing/2026-07-29T08-34-45-359Z-deterministic/summary.json`
- Status: `passed`
- Includes clean build, package/application/test typechecks, all package/application suites, generated checks, and deterministic yo-chat E2E.

## Storage/live evidence

Cut 1 did not change Execution Store persistence. Live Redis evidence remains required at Cut 4 and is not substituted by an earlier run.

## Status

**Cut 1 complete.** Foundation is generic, effect/model-sampling ownership is in durable-effects, program/runtime identity and authoring validation are in durable-execution, tool/resource refinements are in agent-sdk, and the digest-indexed schema registry is in journal-authority. Session Contract now retains only authority/storage/workspace/tool-transport responsibilities scheduled for later cuts; it has no duplicate Cut 1 runtime contract identity or forwarding export.
