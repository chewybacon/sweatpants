# Normative Specification: Effection PR 1168 Preview Package Unification Specification

## Status
Draft

## Abstract
This specification defines the normative requirements for updating the full `pnpm` workspace so every direct and transitive dependency on `effection` resolves to the PR 1168 preview package at `https://pkg.pr.new/effection@1168`, with no remaining alternate Effection versions in manifests, peer handling, lockfile resolution, or the installed dependency graph.

## 1. Introduction

### 1.1 Purpose
This specification exists to make the Effection PR 1168 preview package the only installed and resolved `effection` package in the repository. The repository currently permits multiple Effection versions through workspace catalog ranges, direct workspace manifest ranges, and transitive `@effectionx/*` dependencies. This specification defines the required manifest, catalog, override, lockfile, peer compatibility, and verification behavior needed to eliminate those duplicate versions.

### 1.2 Scope
This specification covers:

- The root `package.json` `pnpm` configuration.
- The root `pnpm-workspace.yaml` catalog.
- Every workspace `package.json` under configured workspace packages and apps.
- `pnpm-lock.yaml` dependency resolution.
- Direct and transitive dependency graph verification.
- Peer dependency handling for workspace packages and third-party package warnings.
- Minimum quality gates for the dependency update.

This specification does not require:

- Publishing any workspace package.
- Replacing `pnpm` or changing workspace layout.
- Upgrading unrelated dependencies unless required to achieve single-version Effection resolution.
- Broad Effection API migration beyond the minimal changes required for install, typecheck, build, and tests to pass with the preview package.

### 1.3 Terminology
The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in RFC 2119.

- **Workspace**: The full repository managed by `pnpm-workspace.yaml`, including the root package, every package under `packages/*`, and every app under `apps/*`.
- **Preview package**: The Effection PR 1168 package address `https://pkg.pr.new/effection@1168`.
- **Resolved preview version**: The concrete package version and tarball resolved by `pnpm install` for `https://pkg.pr.new/effection@1168`. At research time this packed as `effection@4.0.2-pr+3425d5687eb669b25f4ee33d4ec333a088f179f7`, but the lockfile is authoritative after install.
- **Direct dependency declaration**: An `effection` entry in `dependencies`, `devDependencies`, or `optionalDependencies` of a workspace `package.json`.
- **Peer dependency declaration**: An `effection` entry in `peerDependencies` of a workspace `package.json`.
- **Legacy Effection version**: Any non-preview Effection version, including but not limited to `4.0.0`, `4.0.2`, and `4.1.0-alpha.7`.
- **Canonical package specifier**: The exact string `https://pkg.pr.new/effection@1168`.

## 2. Functional Requirements

### 2.1 Canonical Dependency Source

#### REQ-001: Workspace catalog MUST use the PR 1168 preview package
The `pnpm-workspace.yaml` catalog entry for `effection` MUST be set to the canonical package specifier `https://pkg.pr.new/effection@1168`.

**Rationale**: The workspace catalog is the existing source of truth for direct workspace Effection dependencies. Setting it to the preview package ensures all `catalog:` consumers converge on the requested package.

**Acceptance Criteria**:
- [ ] `pnpm-workspace.yaml` contains `effection: https://pkg.pr.new/effection@1168` in the active catalog.
- [ ] `pnpm-workspace.yaml` does not contain an active `effection` catalog value of `^4.1.0-alpha.7`, `^4.0.0`, `^4.0.0-beta.3`, `4.0.0`, `4.0.2`, or any other non-preview specifier.

#### REQ-002: Root overrides MUST force all `effection` requests to the preview package
The root `package.json` `pnpm.overrides` configuration MUST include an `effection` override whose value is the canonical package specifier `https://pkg.pr.new/effection@1168`.

**Rationale**: Transitive dependencies such as `@effectionx/*` may request older Effection ranges. A root package-name override is required to prevent those dependencies from installing a second Effection version.

**Acceptance Criteria**:
- [ ] Root `package.json` contains `"pnpm": { "overrides": { "effection": "https://pkg.pr.new/effection@1168" } }` or an equivalent object preserving existing keys.
- [ ] Existing unrelated root overrides, including `@effectionx/signals` and `@effectionx/timebox`, remain present unless a documented implementation reason requires changing them.
- [ ] After `pnpm install`, transitive dependencies requesting `effection` resolve to the preview package rather than to their original legacy ranges.

#### REQ-003: Direct workspace dependencies MUST use `catalog:`
Every direct dependency declaration for package name `effection` in workspace `package.json` files MUST use the specifier `catalog:`.

**Rationale**: Direct workspace manifests should not duplicate the preview URL or preserve stale semver ranges. `catalog:` makes `pnpm-workspace.yaml` the single direct-dependency source of truth.

**Acceptance Criteria**:
- [ ] Root `package.json` direct `dependencies`, `devDependencies`, and `optionalDependencies` entries for `effection`, if present, use `catalog:`.
- [ ] Every `apps/*/package.json` direct `dependencies`, `devDependencies`, and `optionalDependencies` entry for `effection`, if present, uses `catalog:`.
- [ ] Every `packages/*/package.json` direct `dependencies`, `devDependencies`, and `optionalDependencies` entry for `effection`, if present, uses `catalog:`.
- [ ] `apps/hydra/package.json` no longer declares `dependencies.effection` as `^4.0.0-beta.3`; it uses `catalog:` if it directly depends on Effection.

#### REQ-004: Workspace manifests MUST NOT declare legacy direct Effection ranges
Workspace `package.json` files MUST NOT declare direct `effection` dependency specifiers that point to legacy semver ranges or versions.

**Rationale**: Legacy direct ranges make the manifest state ambiguous and can reintroduce duplicate dependency resolution when overrides or catalogs change.

**Acceptance Criteria**:
- [ ] Searching all workspace `package.json` files finds no direct `effection` dependency values of `^4.0.0-beta.3`, `^4.0.0`, `^4.1.0-alpha.7`, `4.0.0`, `4.0.2`, `4.1.0-alpha.7`, or any other non-`catalog:` direct specifier.
- [ ] Any future direct workspace Effection dependency introduced as part of this change uses `catalog:`.

### 2.2 Peer Dependency Compatibility

#### REQ-005: Workspace Effection peer dependency ranges MUST accept the resolved preview version
Every workspace peer dependency declaration for package name `effection` MUST use a valid semver range that accepts the resolved preview version recorded by the regenerated lockfile.

**Rationale**: Peer dependencies do not install packages, but incompatible peer ranges can produce warnings, obscure the intended compatibility contract, and encourage accidental installation of another Effection version by consumers.

**Acceptance Criteria**:
- [ ] Workspace `peerDependencies.effection` values are semver ranges, not URL specifiers.
- [ ] Each workspace `peerDependencies.effection` range accepts the resolved preview version from `pnpm-lock.yaml` under normal semver evaluation.
- [ ] `packages/framework/package.json` no longer uses a peer range that rejects the resolved preview version, such as plain `^4.0.0` if it does not match the preview version.
- [ ] `apps/hydra/package.json`, if it retains `peerDependencies.effection`, uses a peer range that accepts the resolved preview version.

#### REQ-006: Peer warning suppression MUST NOT introduce an additional Effection installation
If third-party peer dependency warnings occur because a package's peer range does not recognize the preview version, the implementation MAY add `pnpm.peerDependencyRules.allowedVersions` or `pnpm.packageExtensions`, but it MUST NOT add a second `effection` dependency or override that resolves to any non-preview version.

**Rationale**: Clean peer resolution is desirable, but the user's primary requirement is no exceptions in the resolved Effection graph.

**Acceptance Criteria**:
- [ ] Any peer warning mitigation in root `package.json` references the preview package version or compatible preview semver range only.
- [ ] `pnpm list effection -r --depth 10` still shows only the preview package after peer warning mitigation.
- [ ] No root or workspace manifest introduces an additional non-preview `effection` specifier to satisfy peer warnings.

### 2.3 Lockfile and Installation

#### REQ-007: The lockfile MUST be regenerated with `pnpm install`
The implementation MUST run `pnpm install` after manifest and workspace catalog changes so that `pnpm-lock.yaml` reflects the preview package resolution.

**Rationale**: The lockfile controls reproducible installs. Manifest changes without a lockfile update would leave the repository in an inconsistent state.

**Acceptance Criteria**:
- [ ] `pnpm-lock.yaml` changes are present when manifest or catalog changes require lockfile updates.
- [ ] `pnpm install --frozen-lockfile` would not be required for the update step; the lockfile is regenerated from the new dependency configuration.
- [ ] A subsequent `pnpm install --frozen-lockfile` succeeds after the lockfile has been updated.

#### REQ-008: The lockfile MUST contain exactly one Effection package resolution
After installation, `pnpm-lock.yaml` MUST contain exactly one resolved package entry for package name `effection`, and that entry MUST resolve to the PR 1168 preview package.

**Rationale**: Lockfile uniqueness is the reproducible-install proof that no direct or transitive dependency is pinned to a second Effection version.

**Acceptance Criteria**:
- [ ] `pnpm-lock.yaml` contains no package entries for `effection@4.0.0`, `effection@4.0.2`, `effection@4.1.0-alpha.7`, or any other non-preview Effection package.
- [ ] `pnpm-lock.yaml` contains a preview `effection` resolution corresponding to `https://pkg.pr.new/effection@1168` or its resolved tarball.
- [ ] All lockfile dependency references to package name `effection` point to the single preview resolution.

#### REQ-009: Installed dependency graph MUST contain exactly one Effection version
After installation, the effective workspace dependency graph MUST contain exactly one `effection` package version, and that version MUST be the resolved preview version from `https://pkg.pr.new/effection@1168`.

**Rationale**: The installed graph is the runtime proof that apps and packages will import the same Effection implementation.

**Acceptance Criteria**:
- [ ] `pnpm list effection -r --depth 10` reports only the preview Effection package.
- [ ] `pnpm list effection -r --depth 10` does not report `4.0.0`, `4.0.2`, `4.1.0-alpha.7`, or any other non-preview version.
- [ ] Every listed workspace package that depends on Effection points to the same resolved preview package.

### 2.4 Verification and Quality Gates

#### REQ-010: Legacy Effection specifier search MUST pass
The implementation MUST verify that legacy Effection direct ranges and lockfile package entries are absent using a repository-wide search.

**Rationale**: A graph check can prove installed uniqueness, but a source search catches stale manifest declarations and lockfile leftovers before they become future drift.

**Acceptance Criteria**:
- [ ] The following command, or an equivalent command with the same coverage, returns no matches for legacy installed versions or direct legacy ranges:

  ```sh
  rg "effection@(4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)|effection: (\\^4\\.0\\.0|\\^4\\.1\\.0-alpha\\.7|4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)" pnpm-lock.yaml package.json pnpm-workspace.yaml apps packages
  ```

- [ ] If an equivalent command is used, it covers root manifests, workspace manifests, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`.

#### REQ-011: Minimum quality gates MUST pass
The implementation MUST pass `pnpm install`, `pnpm check`, and targeted tests for Effection-heavy packages.

**Rationale**: Dependency convergence must not leave the workspace in an uninstallable or type-broken state. Effection-heavy package tests provide confidence that the preview package works in core runtime paths.

**Acceptance Criteria**:
- [ ] `pnpm install` completes successfully.
- [ ] `pnpm check` completes successfully.
- [ ] `pnpm -C packages/core test` completes successfully, or any failure is documented as unrelated to the Effection preview update.
- [ ] `pnpm -C packages/framework test` completes successfully, or any failure is documented as unrelated to the Effection preview update.

#### REQ-012: Source changes for preview compatibility MUST be minimal and dependency-focused
If source changes are required because the PR 1168 preview changes Effection lifecycle behavior or types, those changes MUST be limited to what is necessary for install, typecheck, build, or targeted tests to pass.

**Rationale**: This work item is a dependency unification change, not a broad application refactor.

**Acceptance Criteria**:
- [ ] Source changes, if any, are traceable to preview package compatibility or resulting test/type failures.
- [ ] The implementation does not introduce unrelated feature changes.
- [ ] Any larger follow-up work discovered during compatibility fixes is tracked separately rather than folded into this change.

### 2.5 Change Control

#### REQ-013: Unrelated dependencies SHOULD NOT be changed
The implementation SHOULD NOT upgrade, downgrade, add, or remove dependencies unrelated to Effection resolution unless the change is required to make all Effection dependencies resolve to the preview package or to keep quality gates passing.

**Rationale**: Reducing unrelated dependency churn keeps the change reviewable and isolates risk.

**Acceptance Criteria**:
- [ ] Non-Effection dependency changes are absent or explicitly justified in implementation notes.
- [ ] Existing root `pnpm.overrides` unrelated to package name `effection` are preserved unless a justified compatibility reason exists.

#### REQ-014: The package manager and workspace layout MUST remain unchanged
The implementation MUST continue to use `pnpm@10.24.0` and the existing workspace layout declared in `pnpm-workspace.yaml`.

**Rationale**: The design specifically targets pnpm catalog and override behavior. Changing package managers or workspace layout would expand scope and invalidate the proposed solution.

**Acceptance Criteria**:
- [ ] Root `package.json` still declares `"packageManager": "pnpm@10.24.0"` unless an unrelated pre-existing repository policy requires otherwise.
- [ ] `pnpm-workspace.yaml` continues to include the existing workspace package patterns, including `packages/*` and `apps/*`.
- [ ] No npm, Yarn, Bun, or alternate package-manager lockfile is introduced as part of this change.

## 3. Interfaces and Configuration Contracts

### 3.1 Workspace Catalog Interface
The workspace catalog is defined in `pnpm-workspace.yaml`. The `effection` key MUST resolve to the canonical package specifier.

Expected configuration shape:

```yaml
catalog:
  effection: https://pkg.pr.new/effection@1168
```

Additional catalog entries MAY remain unchanged.

### 3.2 Root pnpm Override Interface
The root `package.json` `pnpm.overrides` object MUST include the `effection` override while preserving existing unrelated overrides.

Expected configuration shape:

```json
{
  "pnpm": {
    "overrides": {
      "@effectionx/signals": "^0.5.0",
      "@effectionx/timebox": "^0.4.0",
      "effection": "https://pkg.pr.new/effection@1168"
    }
  }
}
```

The order of object keys is not normative.

### 3.3 Workspace Manifest Interface
Workspace direct Effection dependencies MUST use this shape when present:

```json
{
  "dependencies": {
    "effection": "catalog:"
  }
}
```

The same `catalog:` value applies when `effection` appears in `devDependencies` or `optionalDependencies`.

Workspace peer Effection dependencies MUST use semver ranges, for example:

```json
{
  "peerDependencies": {
    "effection": ">=4.0.2-pr <4.0.3"
  }
}
```

The example range is illustrative only. The actual range MUST accept the resolved preview version recorded by the regenerated lockfile.

### 3.4 Verification Command Interface
The implementation MUST provide command output or notes for the following checks:

```sh
pnpm install
pnpm list effection -r --depth 10
rg "effection@(4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)|effection: (\\^4\\.0\\.0|\\^4\\.1\\.0-alpha\\.7|4\\.0\\.0|4\\.0\\.2|4\\.1\\.0-alpha\\.7)" pnpm-lock.yaml package.json pnpm-workspace.yaml apps packages
pnpm check
pnpm -C packages/core test
pnpm -C packages/framework test
```

Equivalent commands MAY be used when they prove the same requirements with equal or greater coverage.

## 4. Error Handling

#### REQ-015: Preview package availability failures MUST stop implementation validation
If `pnpm install` cannot fetch `https://pkg.pr.new/effection@1168`, the implementation MUST NOT substitute a legacy Effection version to make installation pass.

**Rationale**: Falling back to a legacy version would directly violate the no-exceptions requirement.

**Acceptance Criteria**:
- [ ] Install failures caused by preview package unavailability are reported as blocking failures.
- [ ] No fallback dependency specifier such as `^4.1.0-alpha.7`, `4.0.2`, or `^4.0.0` is introduced.

#### REQ-016: Verification failures MUST be fixed or explicitly reported
If verification finds more than one Effection version, any legacy Effection lockfile entry, or any legacy direct manifest range, the implementation MUST either fix the issue before completion or explicitly report the remaining blocker.

**Rationale**: The primary acceptance criterion is absolute. Partial convergence must not be presented as complete.

**Acceptance Criteria**:
- [ ] Any non-preview `effection` version found by `pnpm list` is resolved before completion or documented as a blocker.
- [ ] Any legacy direct manifest range found by search is resolved before completion or documented as a blocker.
- [ ] Any lockfile package entry for a non-preview Effection version is resolved before completion or documented as a blocker.

## 5. Security and Supply Chain Considerations

#### REQ-017: The preview dependency source MUST be explicit and reviewable
The preview package source MUST remain visible as `https://pkg.pr.new/effection@1168` in dependency configuration rather than being hidden behind an undocumented alias or local tarball.

**Rationale**: PR preview packages are external supply-chain inputs. Reviewers must be able to identify the source and reason for the non-registry dependency.

**Acceptance Criteria**:
- [ ] The canonical preview URL appears in `pnpm-workspace.yaml` and root `package.json` override configuration.
- [ ] The implementation does not replace the preview URL with an opaque local file path, vendored tarball, or unpublished private alias.

#### REQ-018: The lockfile MUST pin the resolved preview artifact
The regenerated `pnpm-lock.yaml` MUST pin the concrete preview artifact resolved by `pnpm install`.

**Rationale**: Lockfile pinning is required for reproducible installs when using preview package URLs.

**Acceptance Criteria**:
- [ ] `pnpm-lock.yaml` records the concrete resolved preview package or tarball for `effection`.
- [ ] Reinstalling with the committed lockfile does not resolve a legacy Effection version.

## 6. Migration and Compatibility

#### REQ-019: Migration MUST include every workspace package and app
The migration MUST include the root package, every app under `apps/*`, and every package under `packages/*`.

**Rationale**: The user explicitly required everything to use the same Effection version with no exceptions.

**Acceptance Criteria**:
- [ ] Manifest scans cover root `package.json`, `apps/*/package.json`, and `packages/*/package.json`.
- [ ] Dependency graph verification is run with recursive workspace coverage using `pnpm list effection -r --depth 10` or an equivalent recursive command.

#### REQ-020: Existing import specifiers MAY remain unchanged
Source imports from `effection` and `effection/experimental` MAY remain unchanged unless the preview package requires code changes for typecheck or tests.

**Rationale**: The requested change is dependency resolution unification, not an import-path migration.

**Acceptance Criteria**:
- [ ] Existing source import paths are not rewritten solely for style or preference.
- [ ] Any source import changes are tied to preview compatibility failures.

## 7. Traceability Matrix

| Design Requirement | Normative Requirement(s) |
| --- | --- |
| Catalog resolves to preview package | REQ-001 |
| Direct workspace dependencies use `catalog:` | REQ-003, REQ-004 |
| Root overrides force transitive dependencies | REQ-002, REQ-006 |
| Peer ranges accept preview package | REQ-005, REQ-006 |
| Lockfile contains one preview resolution | REQ-007, REQ-008, REQ-018 |
| Installed graph reports one preview version | REQ-009, REQ-019 |
| No legacy direct ranges remain | REQ-004, REQ-010, REQ-016 |
| Quality gates pass | REQ-011, REQ-012 |
| Preserve scope and avoid unrelated churn | REQ-013, REQ-014, REQ-020 |
| Handle preview availability and verification failures | REQ-015, REQ-016, REQ-017 |

## References
- Design Document: [.pi/specs/effection-preview-unification-design.md](.pi/specs/effection-preview-unification-design.md)
- Effection PR 1168: [https://github.com/thefrontside/effection/pull/1168](https://github.com/thefrontside/effection/pull/1168)
- Preview package install command from PR bot: `npm i https://pkg.pr.new/effection@1168`
- RFC 2119: [https://www.rfc-editor.org/rfc/rfc2119](https://www.rfc-editor.org/rfc/rfc2119)
