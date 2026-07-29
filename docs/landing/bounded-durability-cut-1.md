# Bounded durability closure — Cut 1 landing record

## Savepoints

- `e6e7d28` — generic role-parameterized descriptor mechanics; removed Foundation's closed role algebra and registry-entry alias.
- `c43e018` — durable-effects, durable-execution, and Core domain role refinements.
- `c929762` — Journal Authority runtime schema registry, Tool Session foreign contract/adapter, canonical durable-execution local context/driver, consumer migration, and deletion of Session Contract schema/foreign declarations.

## Moved and deleted paths

- `session-contract/schema-registry*` → `journal-authority/schema-registry*`.
- `session-contract/foreign-tool-{contract,adapter}.ts` → `tool-session/foreign-{contract,adapter}.ts`.
- Deleted `session-contract/schema.ts` and its schema registry test/export surface.
- Added `foundation/schema-validation.ts`, `durable-execution/schema.ts`, `durable-execution/program-context.ts`, and `durable-execution/local-program-driver.ts`.

## Production and residue searches

```text
rg DurableSchemaRegistryEntry packages apps               => 0
rg PortableSchemaRole packages apps                       => 0
rg session-contract/src/(schema|schema-registry) => 0 production paths
validate-module-graph                                      => 27 packages, no package cycles, no violations
```

The two remaining baselined Framework module cycles are Cut 3 work; no new cycle was accepted.

## Narrow evidence

- Foundation: 35 tests passed; package typecheck passed.
- Durable Execution: 16 tests passed; package typecheck passed.
- Core: 148 tests passed; package typecheck and strict test typecheck passed.
- Journal Authority: 11 tests passed, including four registry-boundary tests; package typecheck passed.
- Session Contract: 79 tests passed after old schema/foreign path deletion; package typecheck passed.
- A2A: 48 passed, one explicitly live-only skip; package typecheck passed.
- Tool Runtime Local focused foreign child/facade corpus: 5 passed.
- Framework focused handler/AG-UI/golden-path corpus: 54 passed.

## Graph, exports, and build evidence

- `pnpm check` passed after rebuilding changed declaration producers.
- `pnpm validate:exports` passed for 27 packages.
- `pnpm validate:product-surface` passed (14 facade paths, two product apps, one golden suite).
- `pnpm validate:module-graph` passed with zero package cycles, two pre-existing baselined Framework module cycles, and zero architecture violations.

## Storage/live evidence

This destination stage did not change Execution Store persistence. Live Redis evidence remains required at Cut 4. The prior audit-gate live run is not reused as Cut 4 certification.

## Status

Cut 1 remains open until the remaining Session Contract program/effect declarations and runtime forwarding surfaces are switched and deleted. This record deliberately does not claim overall or Cut 1 completion.
