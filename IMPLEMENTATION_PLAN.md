# Implementation Plan: TypeScript Project References and Development Exports

**Date**: 2026-01-11
**Related**: [Issue #1](https://github.com/chewybacon/sweatpants/issues/1), [Compliance Report](./COMPLIANCE_REPORT.md)

---

## Overview

This plan addresses compliance gaps for **tsc-buildable workspaces only**. Based on the updated compliance report, only 4 workspaces require composite mode and project references. Bundler-based apps (yo-agent, yo-chat, yo-mcp) and yo-slides are correctly excluded.

**Scope**: 4 tsc-buildable workspaces
- Root
- packages/elicit-context
- packages/cli
- packages/framework
- apps/hydra

**Excluded** (and why):
- packages/ts-config: Config-only package, no TypeScript code to compile
- yo-agent, yo-chat, yo-mcp: Use bundlers (tsup/vite) with `noEmit: true`, incompatible with composite mode
- yo-slides: No TypeScript

---

## Phase 1: Root Configuration

**Goal**: Set up root tsconfig.json with project references to enable `tsc -b` for tsc-buildable workspaces.

### 1.1 Update Root tsconfig.json

**File**: `/tsconfig.json`

**Action**: Replace entire file

**Content**:
```json
{
  "extends": "@tanstack/ts-config/tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "paths": {
      "@sweatpants/framework": ["packages/framework/src"],
      "@sweatpants/framework/*": ["packages/framework/src/*"]
    }
  },
  "references": [
    { "path": "./packages/elicit-context" },
    { "path": "./packages/cli" },
    { "path": "./packages/framework" },
    { "path": "./apps/hydra" }
  ],
  "files": []
}
```

**Rationale**:
- `references` array enables `tsc -b` to understand build order
- Only includes tsc-buildable workspaces with actual TypeScript code (4 total)
- Excludes ts-config (config-only package, no code to compile)
- Excludes bundler-based apps (yo-agent, yo-chat, yo-mcp) - they use their own build tools
- Excludes yo-slides (no TypeScript)
- `files: []` prevents root from compiling directly
- Keep `paths` for IDE convenience (works alongside references)

**Expected Result**:
```bash
tsc -b
# Will fail until workspace configs updated - expected
```

---

## Phase 2: Package Configurations

**Goal**: Update all packages with composite mode, references, and development exports.

### 2.1 Update @sweatpants/elicit-context

#### 2.1.1 package.json - Add Development Export

**File**: `/packages/elicit-context/package.json`

**Action**: Edit the `exports` section

**Find**:
```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

**Replace with**:
```json
"exports": {
  ".": {
    "development": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

**Rationale**:
- Development export MUST come first (condition order matters)
- Enables VSCode to resolve to TypeScript source during development
- Critical for AC1: IntelliSense without pre-build

#### 2.1.2 tsconfig.json - Add Composite Mode

**File**: `/packages/elicit-context/tsconfig.json`

**Action**: Replace entire file

**Content**:
```json
{
  "extends": "../ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Changes**:
- ✅ Added `composite: true` (required for project references)
- ✅ Explicit `outDir` (defensive, already in base)
- ℹ️ No `references` needed (no workspace dependencies)

**Expected Behavior**: Inherits `declarationMap: true` from tsconfig.package.json

---

### 2.2 Update @sweatpants/cli

#### 2.2.1 package.json - Add Development Export

**File**: `/packages/cli/package.json`

**Action**: Edit the `exports` section

**Find**:
```json
"exports": {
  ".": {
    "types": "./dist/cli.d.ts",
    "import": "./dist/cli.js",
    "default": "./dist/cli.js"
  }
}
```

**Replace with**:
```json
"exports": {
  ".": {
    "development": "./src/cli.ts",
    "types": "./dist/cli.d.ts",
    "import": "./dist/cli.js",
    "default": "./dist/cli.js"
  }
}
```

#### 2.2.2 tsconfig.json - Add Composite Mode

**File**: `/packages/cli/tsconfig.json`

**Action**: Replace entire file

**Content**:
```json
{
  "extends": "../ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Changes**:
- ✅ Added `composite: true`
- ✅ Explicit `outDir`
- ℹ️ No `references` needed (no workspace dependencies)

---

### 2.3 Update @sweatpants/framework

#### 2.3.1 package.json - Already Compliant

**File**: `/packages/framework/package.json`

**Status**: ✅ Already has development exports properly ordered

**Action**: No changes needed

All 10 exports already have `development` condition as first entry (e.g., lines 8-10, 22-24, etc.)

#### 2.3.2 tsconfig.json - Add Composite Mode and References

**File**: `/packages/framework/tsconfig.json`

**Action**: Replace entire file

**Content**:
```json
{
  "extends": "@tanstack/ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "**/__tests__/**", "**/*.test.ts", "tests"],
  "references": [
    { "path": "../elicit-context" }
  ]
}
```

**Changes**:
- ✅ Added `composite: true`
- ✅ Explicit `outDir` (defensive)
- ✅ Added `references` to elicit-context (workspace dependency)
- ℹ️ Preserves existing include/exclude patterns

**Rationale**:
- framework depends on @sweatpants/elicit-context (package.json:192)
- Reference ensures changes to elicit-context trigger framework rebuild

---

## Phase 3: Application Configuration (hydra only)

**Goal**: Update the one tsc-buildable application with composite mode.

### 3.1 Update apps/hydra

**File**: `/apps/hydra/tsconfig.json`

**Action**: Replace entire file

**Content**:
```json
{
  "extends": "@tanstack/ts-config/tsconfig.node.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "start.ts", "docs/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

**Changes**:
- ✅ Added `composite: true`
- ✅ Explicit `outDir`
- ℹ️ No `references` needed (no @sweatpants/* dependencies in this app)

**Note on hydra exports**:
- App has exports in package.json (may be publishable as a library)
- For now, treating as application
- If it becomes a consumed library, add development exports later

---

## Phase 4: Bundler-Based Apps (No Changes Required)

**Workspaces**: yo-agent, yo-chat, yo-mcp

**Action**: None

**Rationale**:
These apps are correctly configured to use bundlers for builds:
- ✅ Use `noEmit: true` (correct for bundler workflow)
- ✅ Have `check` scripts for type checking (`tsc --noEmit`)
- ✅ Workspace dependencies properly declared
- ✅ Path mappings provide IDE support until framework exports are available
- ❌ Should NOT have `composite: true` (conflicts with noEmit)
- ❌ Should NOT be in root references (not part of tsc build chain)

**Current approach is correct** - no changes needed.

---

## Verification Plan

Run these tests after each phase to ensure correctness.

### After Phase 1 (Root Config)

```bash
tsc -b
# Expected: Error "Referenced project must have setting 'composite': true"
# Reason: Workspaces not ready yet - this is correct behavior
```

### After Phase 2 (Packages)

```bash
# Test packages individually
tsc -b packages/elicit-context
tsc -b packages/cli
tsc -b packages/framework

# Expected: All succeed, .tsbuildinfo files created in each package
```

### After Phase 3 (All tsc-buildable workspaces)

```bash
# Clean build
pnpm tsc -b --clean

# Full build
pnpm tsc -b

# Expected:
# - Success for all 4 tsc-buildable workspaces
# - .tsbuildinfo files created
# - dist/ directories populated with .js, .d.ts, .d.ts.map files
```

### Change Detection Test

```bash
# After successful build, edit a source file
echo "// test change" >> packages/elicit-context/src/index.ts

# Rebuild
pnpm tsc -b

# Expected: Only elicit-context and framework rebuild (not cli, not hydra)
# Reason: framework depends on elicit-context, others don't
```

### VSCode IntelliSense Test (Manual)

```bash
# Clean all dist folders
rm -rf packages/*/dist apps/*/dist

# Open project in VSCode
# Open apps/yo-chat/src (or any file that imports @sweatpants/framework)
# Test:
# 1. Hover over import from @sweatpants/framework → should show types
# 2. Cmd/Ctrl+Click on imported symbol → should jump to .ts source (not .d.ts)
# 3. IntelliSense should work without running any build

# Expected: All pass
```

### Fresh Clone Test

```bash
cd /tmp
git clone <repo-url> sweatpants-fresh
cd sweatpants-fresh
pnpm install

# Do NOT run build
# Open in VSCode
# Navigate to file that imports @sweatpants/framework
# Test IntelliSense and Go to Definition

# Expected: Works immediately without build
```

### Bundler Apps Still Work

```bash
# Verify bundler apps still build with their own tools
cd apps/yo-chat
pnpm run build
# Expected: Vite build succeeds

cd ../yo-agent
pnpm run build
# Expected: tsup build succeeds

cd ../yo-mcp
pnpm run build
# Expected: tsup build succeeds

# Verify type checking still works
pnpm run check
# Expected: tsc --noEmit succeeds in all three apps
```

---

## Acceptance Criteria Validation

| AC | Description | How to Test | Expected Result |
|----|-------------|-------------|-----------------|
| AC1 | Edit in VSCode with IntelliSense without build | Delete all dist/, open VSCode, check IntelliSense | Types resolve, Go to Def works to .ts files |
| AC2 | Make changes without rebuilding dependencies | Edit elicit-context, run `tsc -b` | Only elicit-context and framework rebuild |
| AC3 | Incremental builds with `tsc --build` | `tsc -b` in root and individual workspaces | Both succeed |
| AC4 | dist only for publishing, not development | Fresh install, open VSCode, no build | IntelliSense works immediately |

---

## Rollback Plan

If issues arise, rollback by phase in reverse order.

### Phase 3 Rollback
```bash
git checkout HEAD -- apps/hydra/tsconfig.json
```

### Phase 2 Rollback
```bash
git checkout HEAD -- packages/framework/tsconfig.json
git checkout HEAD -- packages/cli/tsconfig.json packages/cli/package.json
git checkout HEAD -- packages/elicit-context/tsconfig.json packages/elicit-context/package.json
```

### Phase 1 Rollback
```bash
rm packages/ts-config/tsconfig.json
git checkout HEAD -- tsconfig.json
```

---

## Implementation Checklist

### Phase 1: Root Configuration
- [ ] Update `/tsconfig.json` with 4 workspace references
- [ ] Test: `tsc -b` (expect error - correct)
- [ ] Commit: `feat(build): add root TypeScript project references`

### Phase 2: Packages
- [ ] Update `packages/elicit-context/package.json` (dev export)
- [ ] Update `packages/elicit-context/tsconfig.json` (composite)
- [ ] Update `packages/cli/package.json` (dev export)
- [ ] Update `packages/cli/tsconfig.json` (composite)
- [ ] Update `packages/framework/tsconfig.json` (composite + refs)
- [ ] Test: `tsc -b packages/*` (expect success)
- [ ] Commit: `feat(build): add composite mode and dev exports to packages`

### Phase 3: Applications
- [ ] Update `apps/hydra/tsconfig.json` (composite)
- [ ] Test: `tsc -b` (expect full success)
- [ ] Commit: `feat(build): add composite mode to hydra app`

### Verification
- [ ] Run `pnpm tsc -b --clean && pnpm tsc -b`
- [ ] Test change detection (edit elicit-context, rebuild)
- [ ] Test VSCode IntelliSense (delete dist/, check IDE)
- [ ] Test fresh clone workflow
- [ ] Verify bundler apps still build with their own tools
- [ ] Test all 4 acceptance criteria
- [ ] Document any issues encountered

### Documentation (Post-Implementation)
- [ ] Update README with `tsc -b` workflow
- [ ] Document development exports feature
- [ ] Add troubleshooting section
- [ ] Commit: `docs(build): add TypeScript project references guide`

---

## Timeline Estimate

- **Phase 1**: 5 minutes (1 file)
- **Phase 2**: 25 minutes (5 files + testing)
- **Phase 3**: 10 minutes (1 file + testing)
- **Verification**: 30 minutes (comprehensive tests)

**Total**: ~70 minutes (~1.2 hours)

---

## Post-Implementation Tasks

### 1. Documentation Updates

Create or update these documentation sections:

**README.md additions**:
```markdown
## Development Workflow

### TypeScript Incremental Builds

This monorepo uses TypeScript project references for fast incremental builds:

\`\`\`bash
# Build all packages
pnpm tsc -b

# Clean and rebuild
pnpm tsc -b --clean && pnpm tsc -b

# Build specific workspace
cd packages/framework
tsc -b
\`\`\`

### Development Exports

Packages export TypeScript source files via the `development` condition:
- VSCode automatically resolves to source files
- No build required for IntelliSense
- "Go to Definition" jumps to .ts files, not .d.ts

### Workspace Structure

- **tsc-buildable**: ts-config, elicit-context, cli, framework, hydra
  - Use `tsc -b` for builds
  - Participate in incremental build chain

- **Bundler-based**: yo-agent, yo-chat, yo-mcp
  - Use tsup/vite for builds
  - Type-check with `pnpm check`
  - Not part of `tsc -b` chain
```

**CONTRIBUTING.md additions**:
```markdown
## TypeScript Guidelines

- Packages MUST have development exports pointing to src/
- tsc-buildable workspaces MUST have `composite: true`
- Bundler-based apps MUST keep `noEmit: true`
- New package dependencies MUST add tsconfig references
```

### 2. CI/CD Optimizations (Optional)

If CI currently runs individual builds:

**Before**:
```yaml
- run: pnpm --filter @sweatpants/elicit-context run build
- run: pnpm --filter @sweatpants/cli run build
- run: pnpm --filter @sweatpants/framework run build
```

**After** (faster):
```yaml
- run: pnpm tsc -b  # Builds all in correct order, only what changed
```

### 3. Developer Communication

Notify team about changes:
- New `tsc -b` command for builds
- VSCode IntelliSense works without pre-build
- Development exports enable source navigation
- Bundler apps unchanged (use existing workflows)

---

## Risk Assessment

### Low Risk
- ✅ All changes are backward compatible
- ✅ Can rollback per phase
- ✅ No runtime behavior changes
- ✅ Base configs already correct
- ✅ Bundler apps unaffected

### Potential Issues

| Issue | Likelihood | Impact | Mitigation |
|-------|------------|--------|------------|
| IDE re-indexing slow | Medium | Low | Happens once, temporary |
| .tsbuildinfo in git | Low | Low | Add to .gitignore if not already |
| Developer confusion | Medium | Low | Clear documentation + training |
| Build cache issues | Low | Medium | Document `tsc -b --clean` |

### Mitigation Strategies
1. Phase-by-phase implementation allows early issue detection
2. Comprehensive testing at each phase
3. Clear rollback plan for each phase
4. Documentation prepared before team notification
5. Verification tests cover all scenarios

---

## Success Criteria

All of the following must be true:

- [ ] `tsc -b` succeeds in root directory
- [ ] `tsc -b` succeeds in each tsc-buildable workspace
- [ ] VSCode IntelliSense works without pre-build
- [ ] "Go to Definition" navigates to .ts source files (not .d.ts)
- [ ] Incremental builds only rebuild changed workspaces + dependents
- [ ] Fresh clone + `pnpm install` works in VSCode immediately
- [ ] All 4 acceptance criteria met
- [ ] Bundler apps (yo-agent, yo-chat, yo-mcp) still build successfully
- [ ] Zero TypeScript errors
- [ ] Build time same or faster than before
- [ ] CI/CD pipeline unaffected (or improved)

---

## Troubleshooting Reference

From issue comment, common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `Referenced project must have setting 'composite': true` | Missing composite flag in referenced workspace | Add `"composite": true` to that workspace's tsconfig |
| `Cannot find module '@sweatpants/...'` | Missing workspace dependency or dev export | Verify package.json dependency + development export |
| Go to Def opens `.d.ts` file | Missing declarationMap | Already in base config; check tsconfig extends correctly |
| `error TS6305: Output file has not been built` | outDir not set | Add explicit `"outDir": "./dist"` |
| `Cannot find tsconfig.json` | Referenced workspace missing tsconfig | Create tsconfig.json in that workspace |
| Bundler app fails | Incorrectly added composite mode | Remove composite, keep noEmit: true |

---

## Files Changed Summary

### Modified Files (6)
- `tsconfig.json`
- `packages/elicit-context/package.json`
- `packages/elicit-context/tsconfig.json`
- `packages/cli/package.json`
- `packages/cli/tsconfig.json`
- `packages/framework/tsconfig.json`
- `apps/hydra/tsconfig.json`

### Unchanged (Correct as-is)
- packages/ts-config (config-only package, no code to compile)
- All bundler app configs (yo-agent, yo-chat, yo-mcp)
- yo-slides (no TypeScript)
- Base tsconfig files (@tanstack/ts-config/tsconfig.*.json)

**Total changes**: 6 files
