# Test Plan: Effection PR 1168 Preview Package Unification Test Plan

## Status
Draft

## 1. Overview
This test plan verifies that the full `pnpm` workspace resolves every direct and transitive `effection` dependency to the Effection PR 1168 preview package at `https://pkg.pr.new/effection@1168`, with no legacy Effection versions remaining in manifests, peer handling, lockfile resolution, or the effective installed dependency graph.

**Specification**: [.pi/specs/effection-preview-unification-spec.md](.pi/specs/effection-preview-unification-spec.md)

## 2. Test Strategy

### 2.1 Approach
Testing is primarily repository-level integration testing because the feature is dependency graph unification rather than an application runtime feature. The plan combines:

1. **Static configuration checks** for `pnpm-workspace.yaml`, root `package.json`, workspace manifests, and package manager metadata.
2. **Lockfile checks** to prove reproducible dependency resolution pins exactly one Effection preview artifact.
3. **Installed graph checks** using `pnpm list` to prove the effective dependency graph has no duplicate Effection versions.
4. **Quality gates** using `pnpm check` and targeted package tests to catch type or runtime incompatibilities introduced by the preview package.
5. **Review checks** for minimal scope, supply-chain visibility, and unrelated dependency churn.
6. **Negative checks** executed in a disposable copy or reverted working tree to prove validators catch legacy ranges, missing overrides, invalid peer ranges, and preview unavailability.

### 2.2 Tools
- `pnpm@10.24.0`
- `node`
- `rg` / ripgrep
- Shell commands run from repository root
- Optional temporary validation scripts using Node.js core modules
- Optional semver validator, either an existing transitive `semver` package or `pnpm dlx semver`, for peer range checks
- Existing project quality gates:
  - `pnpm install`
  - `pnpm install --frozen-lockfile`
  - `pnpm check`
  - `pnpm -C packages/core test`
  - `pnpm -C packages/framework test`

### 2.3 Coverage Goals
- 100% of MUST requirements in the approved specification are covered by at least one test case.
- SHOULD requirements are covered where practical.
- Error handling requirements have explicit negative test cases.
- Both static state and effective installed dependency graph are verified.

## 3. Test Cases

### TC-001: Workspace catalog points to PR 1168 preview package
- **Requirement**: REQ-001
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Dependency update has been implemented.
- **Steps**:
  1. Open `pnpm-workspace.yaml`.
  2. Locate the active `catalog:` entry for `effection`.
  3. Confirm its value is exactly `https://pkg.pr.new/effection@1168`.
  4. Search `pnpm-workspace.yaml` for legacy Effection catalog values.
- **Expected Result**: `pnpm-workspace.yaml` contains an active `effection: https://pkg.pr.new/effection@1168` catalog entry and contains no active legacy catalog value for `effection`.
- **Notes**: This test should fail if the catalog still uses `^4.1.0-alpha.7` or any other semver range.

### TC-002: Root pnpm override forces Effection preview package
- **Requirement**: REQ-002
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Dependency update has been implemented.
- **Steps**:
  1. Open root `package.json`.
  2. Inspect `pnpm.overrides`.
  3. Confirm `pnpm.overrides.effection` equals `https://pkg.pr.new/effection@1168`.
  4. Confirm existing unrelated overrides, including `@effectionx/signals` and `@effectionx/timebox`, remain unless an implementation note explicitly justifies a change.
  5. Run `pnpm install`.
  6. Run `pnpm list effection -r --depth 10`.
- **Expected Result**: Root override exists, unrelated overrides are preserved or justified, install succeeds, and transitive Effection consumers resolve to the preview package.

### TC-003: Direct workspace Effection dependencies all use `catalog:`
- **Requirement**: REQ-003, REQ-019
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Dependency update has been implemented.
- **Steps**:
  1. Run a manifest scan across root `package.json`, `apps/*/package.json`, and `packages/*/package.json`.
  2. For every `effection` entry in `dependencies`, `devDependencies`, or `optionalDependencies`, verify the value is exactly `catalog:`.
  3. Specifically inspect `apps/hydra/package.json` if present.
- **Expected Result**: Every direct workspace Effection dependency uses `catalog:`. `apps/hydra/package.json` no longer declares `dependencies.effection` as `^4.0.0-beta.3`.
- **Suggested Command**:
  ```sh
  node - <<'JS'
  const fs = require('fs');
  const path = require('path');
  const roots = ['package.json'];
  for (const base of ['apps', 'packages']) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const pkg = path.join(base, name, 'package.json');
      if (fs.existsSync(pkg)) roots.push(pkg);
    }
  }
  let failed = false;
  for (const file of roots) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const value = json[section]?.effection;
      if (value !== undefined && value !== 'catalog:') {
        console.error(`${file} ${section}.effection is ${value}, expected catalog:`);
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
  JS
  ```

### TC-004: No legacy direct Effection ranges remain in workspace manifests
- **Requirement**: REQ-004, REQ-010
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Dependency update has been implemented.
- **Steps**:
  1. Run the legacy specifier search from the specification.
  2. Confirm no workspace manifest direct dependency contains legacy Effection versions or ranges.
- **Expected Result**: Search returns no matches for legacy direct Effection ranges in root, app, or package manifests.
- **Command**:
  ```sh
  rg "effection@(4\.0\.0|4\.0\.2|4\.1\.0-alpha\.7)|effection: (\^4\.0\.0|\^4\.1\.0-alpha\.7|4\.0\.0|4\.0\.2|4\.1\.0-alpha\.7)" pnpm-lock.yaml package.json pnpm-workspace.yaml apps packages
  ```

### TC-005: Workspace Effection peer ranges accept resolved preview version
- **Requirement**: REQ-005
- **Type**: Integration
- **Priority**: High
- **Preconditions**: `pnpm install` has completed and `pnpm-lock.yaml` records the resolved preview version.
- **Steps**:
  1. Determine the resolved preview version from `pnpm-lock.yaml` or `pnpm list effection -r --depth 10`.
  2. Scan root, app, and package manifests for `peerDependencies.effection`.
  3. Confirm each peer value is a semver range, not a URL.
  4. Validate that each peer range accepts the resolved preview version under normal semver evaluation.
  5. Specifically check `packages/framework/package.json` and `apps/hydra/package.json` if they declare Effection peers.
- **Expected Result**: All workspace Effection peer ranges are semver ranges and accept the resolved preview version.
- **Notes**: The exact accepted range can vary; it must match the concrete preview version recorded in the lockfile.

### TC-006: Peer warning mitigation does not introduce another Effection resolution
- **Requirement**: REQ-006
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Any peer warning mitigation has been implemented, if needed.
- **Steps**:
  1. Inspect root `package.json` for `pnpm.peerDependencyRules.allowedVersions` and `pnpm.packageExtensions`.
  2. Confirm any mitigation references only the preview version or a compatible preview semver range.
  3. Run `pnpm install`.
  4. Run `pnpm list effection -r --depth 10`.
  5. Search manifests for added non-preview `effection` specifiers.
- **Expected Result**: Peer warning mitigation, if present, does not introduce a second Effection dependency or any non-preview Effection resolution.

### TC-007: Lockfile is regenerated and frozen install succeeds
- **Requirement**: REQ-007
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Manifest and catalog changes are present.
- **Steps**:
  1. Run `pnpm install` from repository root.
  2. Confirm `pnpm-lock.yaml` has changed as needed to reflect the new Effection preview package.
  3. Run `pnpm install --frozen-lockfile`.
- **Expected Result**: `pnpm install` updates the lockfile successfully, and the subsequent frozen install succeeds without lockfile drift.

### TC-008: Lockfile contains exactly one Effection package resolution
- **Requirement**: REQ-008, REQ-018
- **Type**: Integration
- **Priority**: High
- **Preconditions**: `pnpm install` has completed successfully.
- **Steps**:
  1. Inspect `pnpm-lock.yaml` for package entries matching `effection@`.
  2. Confirm there is exactly one resolved package entry for package name `effection`.
  3. Confirm the entry corresponds to `https://pkg.pr.new/effection@1168` or its resolved preview tarball/version.
  4. Confirm no lockfile package entries exist for `effection@4.0.0`, `effection@4.0.2`, `effection@4.1.0-alpha.7`, or any other non-preview version.
- **Expected Result**: Lockfile pins one concrete preview Effection artifact and no legacy Effection artifacts.
- **Suggested Commands**:
  ```sh
  rg "(^|\s)effection@" pnpm-lock.yaml
  rg "effection@(4\.0\.0|4\.0\.2|4\.1\.0-alpha\.7)" pnpm-lock.yaml
  ```
  The first command should show only the preview resolution context; the second command should return no matches.

### TC-009: Installed dependency graph contains exactly one Effection version
- **Requirement**: REQ-009, REQ-019
- **Type**: Integration
- **Priority**: High
- **Preconditions**: `pnpm install` has completed successfully.
- **Steps**:
  1. Run `pnpm list effection -r --depth 10`.
  2. Inspect every Effection line in the output.
  3. Confirm all entries point to the same preview version.
  4. Confirm no output line includes `4.0.0`, `4.0.2`, `4.1.0-alpha.7`, or another non-preview version.
- **Expected Result**: The recursive installed graph reports only the resolved PR 1168 preview package.

### TC-010: Minimum quality gates pass
- **Requirement**: REQ-011
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Dependency update and lockfile regeneration are complete.
- **Steps**:
  1. Run `pnpm install`.
  2. Run `pnpm check`.
  3. Run `pnpm -C packages/core test`.
  4. Run `pnpm -C packages/framework test`.
- **Expected Result**: All commands complete successfully. If a targeted package test fails for an unrelated pre-existing reason, the failure is documented with evidence that it is unrelated to the Effection preview update.

### TC-011: Source compatibility changes are minimal and dependency-focused
- **Requirement**: REQ-012, REQ-020
- **Type**: Review
- **Priority**: High
- **Preconditions**: Implementation diff is available.
- **Steps**:
  1. Review changed source files outside manifest and lockfile files.
  2. For each source change, confirm it is tied to a preview package compatibility failure, typecheck failure, build failure, or targeted test failure.
  3. Confirm import paths from `effection` and `effection/experimental` were not rewritten solely for style or preference.
  4. Confirm larger unrelated follow-up work, if discovered, is tracked separately rather than included in this change.
- **Expected Result**: Source changes are absent or minimal, justified, and directly related to preview compatibility or quality gate failures.

### TC-012: Unrelated dependency churn is absent or justified
- **Requirement**: REQ-013
- **Type**: Review
- **Priority**: Medium
- **Preconditions**: Implementation diff is available.
- **Steps**:
  1. Review changes to `package.json` files and `pnpm-lock.yaml`.
  2. Identify dependency changes unrelated to `effection`, Effection peer handling, or required `@effectionx/*` compatibility.
  3. Confirm unrelated changes are absent or documented with a compatibility rationale.
  4. Confirm existing root overrides unrelated to `effection` are preserved unless justified.
- **Expected Result**: No unrelated dependency upgrade, downgrade, add, or remove occurs without a documented reason.

### TC-013: Package manager and workspace layout are unchanged
- **Requirement**: REQ-014
- **Type**: Integration
- **Priority**: High
- **Preconditions**: Implementation diff is available.
- **Steps**:
  1. Inspect root `package.json`.
  2. Confirm `packageManager` remains `pnpm@10.24.0` unless a pre-existing repository policy explicitly required otherwise.
  3. Inspect `pnpm-workspace.yaml`.
  4. Confirm workspace package patterns still include `packages/*` and `apps/*`.
  5. Confirm no npm, Yarn, Bun, or alternate package-manager lockfile was introduced.
- **Expected Result**: Package manager and workspace layout remain unchanged.

### TC-014: Preview package source remains explicit and reviewable
- **Requirement**: REQ-017
- **Type**: Review
- **Priority**: High
- **Preconditions**: Implementation diff is available.
- **Steps**:
  1. Inspect `pnpm-workspace.yaml` and root `package.json`.
  2. Confirm the string `https://pkg.pr.new/effection@1168` appears in the catalog and root override configuration.
  3. Confirm the preview dependency was not replaced by a local tarball, opaque alias, file path, or unpublished private package.
- **Expected Result**: The preview dependency source is visible and reviewable in committed configuration.

### TC-015: Verification failures are resolved or reported as blockers
- **Requirement**: REQ-016
- **Type**: Review
- **Priority**: High
- **Preconditions**: All verification commands have been run.
- **Steps**:
  1. Review outputs for `pnpm list effection -r --depth 10`, the legacy specifier search, and lockfile checks.
  2. If any check reports multiple versions, legacy ranges, or legacy lockfile entries, confirm the issue was fixed before completion.
  3. If the issue cannot be fixed, confirm it is explicitly documented as a blocker and the implementation is not presented as complete.
- **Expected Result**: No unresolved verification failure remains unless explicitly reported as a blocker.

## 4. Negative Test Cases

### TC-N01: Catalog legacy value is detected
- **Requirement**: REQ-001, REQ-010, REQ-016
- **Purpose**: Verify catalog and legacy search checks fail when the workspace catalog points to a legacy Effection range.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily change `pnpm-workspace.yaml` `catalog.effection` to `^4.1.0-alpha.7`.
  2. Run TC-001 checks.
  3. Run the legacy specifier search from TC-004.
  4. Revert the temporary change.
- **Expected Result**: TC-001 fails because the catalog is not the preview URL. Legacy search reports the legacy catalog value. The change must not be accepted.

### TC-N02: Missing root override allows transitive duplicates to be detected
- **Requirement**: REQ-002, REQ-009, REQ-016
- **Purpose**: Verify graph checks catch duplicate Effection versions when the transitive override is absent.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily remove `pnpm.overrides.effection` from root `package.json`.
  2. Run `pnpm install`.
  3. Run `pnpm list effection -r --depth 10`.
  4. Revert the temporary change and restore the lockfile.
- **Expected Result**: The installed graph check fails if transitive dependencies resolve non-preview Effection versions. The implementation must restore the override before completion.

### TC-N03: Direct legacy workspace dependency is detected
- **Requirement**: REQ-003, REQ-004, REQ-010, REQ-016
- **Purpose**: Verify manifest scans catch a direct workspace dependency that bypasses `catalog:`.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily set `apps/hydra/package.json` `dependencies.effection` to `^4.0.0-beta.3`.
  2. Run the direct dependency scan from TC-003.
  3. Run the legacy specifier search from TC-004.
  4. Revert the temporary change.
- **Expected Result**: The direct dependency scan fails because the value is not `catalog:`. The legacy search reports the legacy range.

### TC-N04: Invalid workspace peer range is detected
- **Requirement**: REQ-005, REQ-016
- **Purpose**: Verify peer validation catches workspace peer ranges that reject the preview version.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward. The resolved preview version is known from the lockfile.
- **Steps**:
  1. Temporarily set a workspace `peerDependencies.effection` value, such as in `packages/framework/package.json`, to a range that rejects the preview version, for example plain `^4.0.0` when it does not accept the resolved preview version.
  2. Run the peer range validation from TC-005.
  3. Revert the temporary change.
- **Expected Result**: Peer range validation fails and identifies the rejecting peer range.

### TC-N05: Preview package unavailability is treated as blocking, not as fallback permission
- **Requirement**: REQ-015, REQ-017
- **Purpose**: Verify install failures for the preview source do not permit fallback to a legacy version.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily change both the catalog and override preview URL to an invalid pkg.pr.new URL, such as `https://pkg.pr.new/effection@definitely-not-a-real-preview`.
  2. Run `pnpm install`.
  3. Confirm the install fails because the preview package cannot be fetched.
  4. Confirm no fallback legacy Effection specifier is added to any manifest.
  5. Revert the temporary change and restore the lockfile.
- **Expected Result**: Install failure is treated as a blocking failure. No legacy fallback is accepted.

### TC-N06: Lockfile legacy entry is detected
- **Requirement**: REQ-008, REQ-010, REQ-016, REQ-018
- **Purpose**: Verify lockfile checks catch legacy Effection package entries.
- **Type**: Negative Integration
- **Priority**: High
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily restore or inject a lockfile state containing `effection@4.0.2` or another legacy Effection entry.
  2. Run TC-008 lockfile checks.
  3. Run the legacy specifier search from TC-004.
  4. Revert the temporary lockfile change.
- **Expected Result**: Lockfile checks and legacy search fail until the legacy lockfile entry is removed.

### TC-N07: Alternate package manager lockfile is detected
- **Requirement**: REQ-014
- **Purpose**: Verify scope checks catch accidental introduction of an alternate package-manager lockfile.
- **Type**: Negative Review
- **Priority**: Medium
- **Preconditions**: Run in a disposable copy, temporary branch, or with changes reverted afterward.
- **Steps**:
  1. Temporarily create `package-lock.json`, `yarn.lock`, or `bun.lockb` at the repository root.
  2. Run TC-013 checks.
  3. Revert the temporary file.
- **Expected Result**: TC-013 fails because an alternate package-manager lockfile was introduced.

## 5. Coverage Matrix

| Requirement | Test Cases | Priority | Status |
|-------------|------------|----------|--------|
| REQ-001 | TC-001, TC-N01 | High | Planned |
| REQ-002 | TC-002, TC-N02 | High | Planned |
| REQ-003 | TC-003, TC-N03 | High | Planned |
| REQ-004 | TC-004, TC-N03 | High | Planned |
| REQ-005 | TC-005, TC-N04 | High | Planned |
| REQ-006 | TC-006 | High | Planned |
| REQ-007 | TC-007 | High | Planned |
| REQ-008 | TC-008, TC-N06 | High | Planned |
| REQ-009 | TC-009, TC-N02 | High | Planned |
| REQ-010 | TC-004, TC-N01, TC-N03, TC-N06 | High | Planned |
| REQ-011 | TC-010 | High | Planned |
| REQ-012 | TC-011 | High | Planned |
| REQ-013 | TC-012 | Medium | Planned |
| REQ-014 | TC-013, TC-N07 | High | Planned |
| REQ-015 | TC-N05 | High | Planned |
| REQ-016 | TC-015, TC-N01, TC-N02, TC-N03, TC-N04, TC-N06 | High | Planned |
| REQ-017 | TC-014, TC-N05 | High | Planned |
| REQ-018 | TC-008, TC-N06 | High | Planned |
| REQ-019 | TC-003, TC-009 | High | Planned |
| REQ-020 | TC-011 | Low | Planned |

## 6. Test Data

### 6.1 Canonical Values
- Canonical preview package specifier: `https://pkg.pr.new/effection@1168`
- Known legacy versions/ranges to reject:
  - `4.0.0`
  - `4.0.2`
  - `4.1.0-alpha.7`
  - `^4.0.0`
  - `^4.0.0-beta.3`
  - `^4.1.0-alpha.7`

### 6.2 Commands to Capture as Evidence
```sh
pnpm install
pnpm install --frozen-lockfile
pnpm list effection -r --depth 10
rg "effection@(4\.0\.0|4\.0\.2|4\.1\.0-alpha\.7)|effection: (\^4\.0\.0|\^4\.1\.0-alpha\.7|4\.0\.0|4\.0\.2|4\.1\.0-alpha\.7)" pnpm-lock.yaml package.json pnpm-workspace.yaml apps packages
pnpm check
pnpm -C packages/core test
pnpm -C packages/framework test
```

### 6.3 Disposable Negative-Test Mutations
Negative test mutations must be temporary and reverted before completion:
- Change catalog Effection value to a legacy range.
- Remove root `pnpm.overrides.effection`.
- Change a direct workspace Effection dependency to a legacy range.
- Change a workspace peer range to one that rejects the preview version.
- Change preview URL to an invalid pkg.pr.new URL.
- Introduce a legacy Effection lockfile entry.
- Add an alternate package-manager lockfile.

## 7. Environment Requirements
- Repository root: `/Users/rrauh/lecode/glg/code/srv/repos/tanstack/sweatpants`
- Network access to `https://pkg.pr.new/effection@1168` for `pnpm install`.
- `pnpm@10.24.0` available via `corepack` or local tooling.
- Node.js available for validation scripts and project tooling.
- Existing project dependencies installable from configured registries.
- Negative tests must run in a disposable copy, temporary branch, or with reliable revert/checkout steps to avoid committing intentionally broken states.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `pkg.pr.new` preview package is unavailable during testing | `pnpm install` fails | Treat as blocking per REQ-015; do not substitute a legacy fallback. Retry only after confirming service availability. |
| PR 1168 preview version changes after lockfile regeneration | Peer range validation or lockfile expectations may change | Use the regenerated lockfile as the authoritative resolved version and validate peer ranges against that version. |
| `pnpm list` output format changes | Manual graph verification may be harder to parse | Use lockfile checks and manifest scans as independent confirmation; use JSON output if needed. |
| Negative tests accidentally leave broken manifest or lockfile changes | False failures or accidental commits | Run negative tests only in disposable copies/branches and verify `git diff` before completion. |
| Existing unrelated tests fail | Effection update may be blocked by noisy pre-existing failures | Document evidence for unrelated failures; do not claim full quality-gate pass unless required gates pass or failures are clearly unrelated. |
| Peer dependency warnings are mistaken for installed duplicates | Unnecessary dependency churn | Verify with `pnpm list effection -r --depth 10`; use peer dependency rules only when needed and ensure they do not add another Effection package. |
| Source compatibility fixes expand into unrelated refactors | Larger review risk and scope creep | Apply TC-011 and TC-012 review checks; track larger follow-up work separately. |
