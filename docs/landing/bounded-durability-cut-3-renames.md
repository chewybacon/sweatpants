# Bounded durability closure — Cut 3 rename savepoints

## Agent SDK

- Commit: `7403187`.
- Atomic move: `packages/core` → `packages/agent-sdk` and `@sweatpants/core` → `@sweatpants/agent-sdk`.
- Consumers, workspace references, product-facade policy, generated reviewer artifact, lockfile links, and documentation were switched in the same landing.
- Search after landing: zero `@sweatpants/core`, `packages/core`, `../core`, or `link:../core` workspace references outside generated/dependency material.
- Narrow: Agent SDK 148 tests passed and package typecheck passed.
- Clean dependency/application build: repository `pnpm build` passed after generated artifact refresh.
- Graph/export/product: 27-package export validation passed; product surface passed; package graph had zero cycles and no violations.

## Platform Acceptance

- Commit: `16781c6`.
- Atomic move: `packages/framework-acceptance` → `packages/platform-acceptance` and package identity to `@sweatpants/platform-acceptance`.
- Workspace references, scripts, lockfile, and documentation switched in the same landing; no forwarding manifest remains.
- Search after landing: zero old acceptance package/path references.
- Narrow: all 82 acceptance tests passed; package typecheck passed.
- A foreign-child composition regression exposed by the rename/build was repaired by making the canonical durable-execution local driver accept an explicit Tool Session child-identity installer; no duplicate identity or bind was introduced.
- Graph/export/product/format: all passed; package graph has zero cycles and no violations.

These are Cut 3 internal savepoints. Framework destination extraction and deletion remain open, so this record does not claim Cut 3 or overall completion.
