# Design: Unify Effection Dependency Resolution on PR 1168 Preview Package

## Status
Draft

## Overview
Update the entire `pnpm` workspace so every direct and transitive `effection` dependency resolves to the Effection PR 1168 preview package (`https://pkg.pr.new/effection@1168`). The change applies to all apps, all packages, root dependencies, workspace catalogs, overrides, peer constraints where possible, and the lockfile. The acceptance bar is zero remaining installed/resolved copies of `effection@4.0.0`, `effection@4.0.2`, `effection@4.1.0-alpha.7`, or any other non-preview Effection version.

## Goals
- Ensure there is exactly one resolved `effection` package across the full workspace dependency graph.
- Make `https://pkg.pr.new/effection@1168` the single source of truth for all direct workspace `effection` dependency declarations.
- Force transitive dependencies, including `@effectionx/*` packages, to resolve their `effection` dependency to the same preview package.
- Normalize workspace manifests so no package bypasses the workspace catalog for direct `effection` dependency resolution.
- Regenerate `pnpm-lock.yaml` so it records only the preview `effection` resolution.
- Provide clear verification commands proving there are no exceptions.

## Non-Goals
- Do not upgrade unrelated dependencies unless required to make all `effection` resolutions converge on the PR 1168 preview package.
- Do not perform a broad Effection API migration beyond fixes required for install, typecheck, build, or tests with the preview package.
- Do not publish workspace packages as part of this change.
- Do not replace the package manager or change workspace layout.

## Requirements
- [ ] REQ-001: The workspace catalog entry for `effection` resolves to `https://pkg.pr.new/effection@1168`.
- [ ] REQ-002: Every direct workspace `effection` dependency uses `catalog:` unless it is a peer dependency range.
- [ ] REQ-003: Root `pnpm.overrides` forces package name `effection` to `https://pkg.pr.new/effection@1168` so transitive dependencies cannot install older Effection versions.
- [ ] REQ-004: Workspace package peer dependency ranges that reference `effection` are updated so the PR preview version is accepted by peer resolution where peer ranges are present.
- [ ] REQ-005: `pnpm-lock.yaml` contains exactly one resolved `effection` package entry, and that entry resolves to the PR 1168 preview package.
- [ ] REQ-006: `pnpm list effection -r --depth 10` reports only the PR 1168 preview package and no other `effection` versions.
- [ ] REQ-007: No `package.json` in the workspace directly declares legacy `effection` ranges such as `^4.0.0-beta.3`, `^4.0.0`, `^4.1.0-alpha.7`, `4.0.0`, `4.0.2`, or `4.1.0-alpha.7` in dependency sections that affect installation.
- [ ] REQ-008: Quality gates for the dependency update pass, at minimum `pnpm install`, `pnpm check`, and targeted tests for packages that exercise Effection-heavy code paths.

## Design Decisions

### Decision 1: Use the PR preview package URL as the canonical dependency spec
- **Context**: The user specifically requested the Effection preview package from PR 1168. GitHub PR 1168's pkg.pr.new bot comment advertises `npm i https://pkg.pr.new/effection@1168`.
- **Options considered**:
  1. Keep `effection: ^4.1.0-alpha.7` and rely on semver ranges. This does not use the requested preview and leaves multiple versions in the graph.
  2. Use the preview URL directly in every workspace package. This is explicit but duplicates the same nonstandard URL across many manifests.
  3. Use the preview URL in the workspace catalog and root overrides. This gives one declarative source for direct dependencies plus a transitive enforcement mechanism.
- **Choice**: Set the workspace catalog's `effection` entry to `https://pkg.pr.new/effection@1168` and use `catalog:` for direct workspace dependencies.
- **Rationale**: This aligns with the existing monorepo pattern, minimizes manifest churn, and gives one place to update when the PR preview changes.

### Decision 2: Use root `pnpm.overrides` to enforce transitive convergence
- **Context**: Current dependency graph includes multiple versions: direct workspace packages resolve to `4.1.0-alpha.7`, some `@effectionx/*` packages pull `4.0.2`, and `apps/hydra` pulls `4.0.0`.
- **Options considered**:
  1. Update only direct dependencies. This leaves transitive `@effectionx/*` dependencies on older Effection versions.
  2. Upgrade every `@effectionx/*` package. This may be unnecessary and may not eliminate all transitive resolutions.
  3. Add a package-name override for `effection`. This forces all transitive requests for `effection` to the preview package.
- **Choice**: Add or update root `pnpm.overrides.effection` to `https://pkg.pr.new/effection@1168` while preserving existing unrelated overrides.
- **Rationale**: `pnpm.overrides` is the most direct way to satisfy the no-exceptions requirement across the entire graph.

### Decision 3: Normalize `apps/hydra` and any future direct outliers to `catalog:`
- **Context**: Most workspace packages already use `effection: catalog:`, but `apps/hydra/package.json` currently declares `effection: ^4.0.0-beta.3` directly.
- **Options considered**:
  1. Leave direct ranges and rely on overrides. This may install correctly but leaves manifest drift and obscures the intended single version.
  2. Replace outlier direct ranges with the preview URL. This duplicates the URL outside the catalog.
  3. Replace outlier direct ranges with `catalog:`.
- **Choice**: Convert every direct workspace `effection` dependency declaration to `catalog:`.
- **Rationale**: This makes the catalog the only direct dependency source and prevents future drift.

### Decision 4: Treat peer dependencies as compatibility constraints, not installed copies
- **Context**: Some workspace manifests declare `effection` as a peer dependency. The current preview package version includes a prerelease-like identifier (`4.0.2-pr+...` at the time of research), and normal ranges such as `^4.0.0` do not satisfy prerelease versions under standard semver checks.
- **Options considered**:
  1. Ignore peer ranges. This may still produce a single installed version but can leave peer warnings and consumer ambiguity.
  2. Put the preview URL in peer dependencies. Peer dependency fields are intended to be semver compatibility ranges, so URL specs are inappropriate for published compatibility declarations.
  3. Use a narrow semver range that accepts the preview's version shape, e.g. `>=4.0.2-pr <4.0.3`, for workspace peer declarations that must recognize this preview.
- **Choice**: Update workspace `effection` peer dependency ranges to accept the PR preview version while remaining semver-based. If pnpm emits peer warnings for third-party `@effectionx/*` packages whose peer ranges exclude prerelease versions, use `pnpm.peerDependencyRules.allowedVersions` or `packageExtensions` as needed to keep install output clean without introducing another installed Effection copy.
- **Rationale**: Peer dependencies do not themselves install a package, but they should not fight the single-version resolution. Semver-based peer ranges keep manifests valid while accepting the preview version.

### Decision 5: Verify using both package graph and lockfile checks
- **Context**: A single command can miss either manifest drift or lockfile leftovers.
- **Options considered**:
  1. Rely only on `pnpm install`. This does not prove uniqueness.
  2. Rely only on grepping the lockfile. This can be brittle and does not show the effective graph.
  3. Use both `pnpm list` and lockfile/package manifest checks.
- **Choice**: Require verification with `pnpm list effection -r --depth 10`, lockfile inspection for old versions, and manifest search for old direct declarations.
- **Rationale**: The user requirement is absolute; multiple independent checks reduce the chance of a hidden exception.

## Constraints
- The repository uses `pnpm@10.24.0` with `pnpm-workspace.yaml` catalogs.
- The preview package URL is external and depends on pkg.pr.new availability.
- The PR 1168 preview may change as the upstream PR changes; `pnpm-lock.yaml` should capture the exact resolved tarball used by this repo after install.
- `@effectionx/*` packages may declare direct dependencies or peers on Effection with ranges that were written for stable releases; overrides and peer handling must account for that.
- Existing root `pnpm.overrides` for `@effectionx/signals` and `@effectionx/timebox` must be preserved unless intentionally changed.

## Dependencies
- **External**: `https://pkg.pr.new/effection@1168` from `thefrontside/effection` PR 1168.
- **External**: Existing `@effectionx/*` packages, including `@effectionx/context-api`, `@effectionx/process`, `@effectionx/tinyexec`, `@effectionx/jsonl-store`, `@effectionx/node`, `@effectionx/stream-helpers`, `@effectionx/vitest`, `@effectionx/websocket`, `@effectionx/worker`, `@effectionx/raf`, `@effectionx/signals`, and `@effectionx/timebox`.
- **Internal**: Root `package.json`, `pnpm-workspace.yaml`, all workspace `package.json` files, and `pnpm-lock.yaml`.
- **Tooling**: `pnpm install`, `pnpm list`, `pnpm check`, and targeted package tests.

## Implementation Outline
1. Update `pnpm-workspace.yaml` catalog entry:
   - Replace `effection: ^4.1.0-alpha.7` with `effection: https://pkg.pr.new/effection@1168`.
2. Update root `package.json` `pnpm.overrides`:
   - Preserve existing overrides.
   - Add `"effection": "https://pkg.pr.new/effection@1168"`.
   - Add peer-dependency allowance/package extension only if install reports peer conflicts caused by preview prerelease semver.
3. Update workspace manifests:
   - Convert `apps/hydra` direct `dependencies.effection` from `^4.0.0-beta.3` to `catalog:`.
   - Search all workspace `package.json` files for direct Effection ranges and normalize any other outliers.
   - Update workspace `peerDependencies.effection` ranges to accept the preview version shape if necessary.
4. Run `pnpm install` to regenerate `pnpm-lock.yaml`.
5. Fix any source/type/test breakages caused by the PR 1168 lifecycle changes, keeping fixes minimal and dependency-focused.
6. Run verification commands and quality gates.

## Acceptance / Verification Commands
- `pnpm install`
- `pnpm list effection -r --depth 10`
  - Expected: only the PR 1168 preview package appears anywhere in the graph.
- `rg "effection@(4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)|effection: (\\^4\\.0\\.0|\\^4\\.1\\.0-alpha\\.7|4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)" pnpm-lock.yaml package.json pnpm-workspace.yaml apps packages`
  - Expected: no matches for legacy installed versions or direct legacy ranges.
- `pnpm check`
- Targeted tests for Effection-heavy packages, preferably:
  - `pnpm -C packages/core test`
  - `pnpm -C packages/framework test`
  - Additional app tests if failures indicate app-level Effection behavior changes.

## Open Questions
None. The user clarified that everything is in scope and every package/dependency must resolve to the same Effection preview version with no exceptions.

## Research Notes
- Current workspace uses `pnpm@10.24.0` and catalogs in `pnpm-workspace.yaml`.
- Current catalog has `effection: ^4.1.0-alpha.7`.
- Current installed graph observed with `pnpm list effection -r --depth 10` includes multiple Effection versions:
  - `effection@4.1.0-alpha.7`
  - `effection@4.0.2`
  - `effection@4.0.0`
- Current direct manifest outlier: `apps/hydra/package.json` declares `dependencies.effection: ^4.0.0-beta.3`.
- Current workspace peer declarations include:
  - `apps/hydra/package.json` `peerDependencies.effection: >=4.0.0-beta.0`
  - `packages/framework/package.json` `peerDependencies.effection: ^4.0.0`
- PR 1168 title: “♻️ Unify task / coroutine lifecycles”.
- PR 1168 bot comment advertises preview install command: `npm i https://pkg.pr.new/effection@1168`.
- A local `npm pack https://pkg.pr.new/effection@1168` during research produced package version `4.0.2-pr+3425d5687eb669b25f4ee33d4ec333a088f179f7`; the exact lockfile resolution should be determined by the final `pnpm install`.
