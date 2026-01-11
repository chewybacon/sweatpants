# Compliance Report: TypeScript Project References and Development Exports

**Date**: 2026-01-11
**Issue**: [#1 - Add project references, partial build and development exports](https://github.com/chewybacon/sweatpants/issues/1)
**Includes**: Additional requirements from issue comments

## Executive Summary

This report evaluates the current state of the sweatpants monorepo against the requirements specified in issue #1 and the additional requirements added in comments. The monorepo currently has **significant compliance gaps** that prevent proper TypeScript incremental builds and VSCode IntelliSense without pre-building.

**Overall Status**: ❌ Non-Compliant

- **Critical Issues**: 8 (in tsc-buildable workspaces)
- **Partial Compliance**: 1 workspace (framework)
- **Compliant Items**: Base TypeScript config, pnpm-workspace.yaml
- **Exempt - Config Only**: 1 workspace (ts-config)
- **Exempt - Bundler-Based**: 3 workspaces (yo-agent, yo-chat, yo-mcp)
- **Exempt - No TypeScript**: 1 workspace (yo-slides)

---

## Requirements Summary

### Original Requirements (from issue body)
1. Development exports pointing to TypeScript sources
2. Workspace dependencies declared in package.json
3. TSConfig references for dependency tracking
4. Composite mode for incremental builds
5. Declaration generation enabled

### Additional Requirements (from comments by taras)
6. **declarationMap: true** - Required for "Go to Definition" to source files
7. **outDir explicitly set** - Required when using composite: true
8. **Development export ordering** - Must come before other conditions
9. **Expanded verification** - tsc -b --clean, change detection, fresh clone test

---

## Good News: Base Configuration is Solid

**packages/ts-config/tsconfig.base.json:16-17**
```json
"declaration": true,
"declarationMap": true,
```

**packages/ts-config/tsconfig.package.json:5-9**
```json
"declaration": true,
"declarationMap": true,
"sourceMap": true,
"noEmit": false,
"outDir": "./dist",
```

✅ The base TypeScript configurations already have the correct settings for `declarationMap` and `outDir`. Workspaces that extend these configs inherit these settings automatically.

---

## Prerequisites Verification

### pnpm-workspace.yaml

**Location**: `/pnpm-workspace.yaml`

#### Status
✅ **Compliant**

#### What's Working
- ✅ **Workspace patterns**: Uses `packages/*` and `apps/*` which correctly includes all workspaces
- ✅ **TypeScript version**: Catalog specifies `typescript: ^5.9.3` (project references require TS 3.0+, work best with TS 4.0+)

#### Workspace Coverage
| Pattern | Directories Covered |
|---------|---------------------|
| `packages/*` | ts-config, elicit-context, cli, framework |
| `apps/*` | hydra, yo-agent, yo-chat, yo-mcp, yo-slides |

**Note**: All workspaces are properly discovered via glob patterns.

---

## Bundler-Based Applications: Special Considerations

Some applications use external bundlers (tsup, vite, etc.) instead of `tsc` for building. These have different requirements:

### Why Composite Mode Doesn't Fit Bundler Apps

| Issue | Explanation |
|-------|-------------|
| `composite` vs `noEmit` | `composite: true` requires TypeScript to emit files, but bundler workflows use `noEmit: true` |
| `allowImportingTsExtensions` | Common in bundler configs, only valid with `noEmit: true` |
| Dual output | Bundlers generate their own `.d.ts` files; tsc would create duplicates |
| Build tool conflict | tsup/vite handle the build; `tsc -b` would interfere |

### Recommended Approach for Bundler Apps

| Aspect | Recommendation |
|--------|----------------|
| `composite` | Skip - not needed for leaf applications |
| `noEmit` | Keep `true` - let bundler handle output |
| Root references | Exclude from `tsc -b` chain |
| Type checking | Use app's own `check` script (`tsc --noEmit`) |
| IDE experience | Works via development exports in dependencies |

### Affected Workspaces

- **yo-agent**: Uses tsup (tsup.config.ts)
- **yo-mcp**: Uses tsup (package.json build script)
- **yo-chat**: Uses vite via TanStack Start

These apps are **exempt from composite mode requirements** but still need:
- ✅ Workspace dependencies properly declared
- ✅ Path mappings for IDE support (optional, development exports preferred)
- ✅ Dependencies to have development exports

---

## Detailed Analysis by Workspace

### 1. Root Configuration

**Location**: `/tsconfig.json`

#### Status
❌ **Non-Compliant**

#### Issues
- ❌ **CRITICAL**: Missing `references` array
  - **Rule**: Root tsconfig.json MUST declare `references` if there are projects that reference other projects
  - **Current State**: No `references` property
  - **Impact**: Cannot use `tsc -b` for incremental builds

#### What's Working
- ✅ Extends base config which has `declaration: true`
- ⚠️ Has `paths` mapping (should be supplemented with references, not replaced)

#### Required Changes
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
    // Excluded - config only (no TypeScript code):
    //   ts-config
    // Excluded - bundler-based apps (use their own build tools):
    //   yo-agent (tsup), yo-chat (vite), yo-mcp (tsup)
    // Excluded - no TypeScript:
    //   yo-slides
  ],
  "files": []
}
```

---

### 2. @sweatpants/framework

**Location**: `/packages/framework`

#### Status
⚠️ **Partially Compliant**

#### What's Working
- ✅ **Development Exports**: All 10 exports have proper `development` entries
- ✅ **Export Ordering**: Development conditions come first (e.g., package.json:8-10)
- ✅ **Workspace Dependencies**: `@sweatpants/elicit-context` properly declared (package.json:192)
- ✅ **Inherits declarationMap**: Extends tsconfig.package.json which has it

#### Issues
- ❌ **CRITICAL**: Missing `composite: true` in tsconfig.json
  - **Current State**: tsconfig.json:2-7 has no `composite` setting
  - **Impact**: TypeScript compiler cannot find outputs for incremental builds
  - **Error Message**: "Referenced project must have setting 'composite': true"

- ❌ **CRITICAL**: Missing `references` array
  - **Current State**: No `references` property in tsconfig.json
  - **Expected**: `"references": [{ "path": "../elicit-context" }]`
  - **Impact**: Changes to elicit-context won't trigger framework rebuild

- ⚠️ **WARNING**: No explicit `outDir` set
  - **Current State**: Relies on inheritance from tsconfig.package.json
  - **Risk**: If composite is added without explicit outDir, may cause TS6305 error
  - **Recommendation**: Explicitly set `"outDir": "./dist"` for clarity

#### Required Changes
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

---

### 3. @sweatpants/elicit-context

**Location**: `/packages/elicit-context`

#### Status
❌ **Non-Compliant**

#### What's Working
- ✅ **Inherits declarationMap and outDir**: Extends tsconfig.package.json (tsconfig.json:2)
- ✅ **Explicit outDir**: Set at tsconfig.json:4

#### Issues
- ❌ **CRITICAL**: Missing development export
  - **Current State**: package.json:9-14 only has production exports
  - **Expected**:
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
  - **Impact**: Dependent workspaces (@sweatpants/framework) must build this package before development
  - **AC1 Impact**: VSCode IntelliSense won't work without pre-build

- ❌ **CRITICAL**: Missing `composite: true`
  - **Current State**: tsconfig.json:2-9 has no `composite` setting
  - **Impact**: Cannot participate in incremental builds
  - **Error**: "Referenced project must have setting 'composite': true"

#### Required Changes

**package.json**:
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

**tsconfig.json**:
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

---

### 4. @sweatpants/cli

**Location**: `/packages/cli`

#### Status
❌ **Non-Compliant**

#### What's Working
- ✅ **Inherits declarationMap and outDir**: Extends tsconfig.package.json (tsconfig.json:2)
- ✅ **Explicit outDir**: Set at tsconfig.json:4

#### Issues
- ❌ **CRITICAL**: Missing development export
  - **Current State**: package.json:11-16 only has production exports
  - **Expected**:
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

- ❌ **CRITICAL**: Missing `composite: true`
  - **Current State**: tsconfig.json:2-9 has no `composite` setting

#### Required Changes

**package.json**: Add development export as shown above

**tsconfig.json**:
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

---

### 5. yo-chat (Application - Bundler-Based)

**Location**: `/apps/yo-chat`
**Build Tool**: Vite via TanStack Start

#### Status
⚠️ **Exempt from Composite** (see [Bundler-Based Applications](#bundler-based-applications-special-considerations))

#### What's Working
- ✅ **Workspace Dependency**: `@sweatpants/framework` declared (package.json:26)
- ✅ **Extends base config**: tsconfig.app.json → tsconfig.base.json
- ✅ **Inherits noEmit**: From tsconfig.app.json (correct for Vite workflow)
- N/A **Development Exports**: Not needed for applications
- N/A **Composite Mode**: Exempt - uses Vite for builds

#### Issues
- ⚠️ **WARNING**: Uses path mapping to framework subpaths
  - **Current State**: tsconfig.json:6-22 has paths to framework source
  - **Better Approach**: Remove paths once framework has development exports for these subpaths

#### Current Config (Acceptable)
The current configuration is appropriate for a Vite-based app. No changes required for composite mode.

**Note**: Path mappings to framework can be removed once framework exports all subpaths with development conditions.

---

### 6. hydra-effection (Application)

**Location**: `/apps/hydra`

#### Status
❌ **Non-Compliant**

#### What's Working
- ✅ **Inherits declarationMap**: Extends tsconfig.node.json → tsconfig.base.json

#### Issues
- ❌ **CRITICAL**: Missing `composite: true`
  - **Current State**: tsconfig.json:2-12 has no `composite` setting

- ⚠️ **QUESTION**: Has exports but marked as application
  - **Current State**: package.json:9-19 has import/require exports
  - **Question**: Is this meant to be a library or an application?
  - **If Library**: Needs development exports
  - **If Application**: Exports may not be necessary

- ⚠️ **WARNING**: No explicit `outDir`
  - **Recommendation**: Add `"outDir": "./dist"`

#### Required Changes

**Minimum (if application)**:
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

**If Library**: Also add development export to package.json

---

### 7. yo-agent (Application - Bundler-Based)

**Location**: `/apps/yo-agent`
**Build Tool**: tsup (tsup.config.ts)

#### Status
⚠️ **Exempt from Composite** (see [Bundler-Based Applications](#bundler-based-applications-special-considerations))

#### What's Working
- ✅ **Workspace Dependency**: `@sweatpants/framework` declared (package.json:18)
- ✅ **Uses noEmit**: Correct for bundler-based workflow (tsconfig.json:11)
- ✅ **Has check script**: `tsc --noEmit` for type checking (package.json:13)
- N/A **Development Exports**: Not needed for applications
- N/A **Composite Mode**: Exempt - uses tsup for builds

#### Issues
- ⚠️ **WARNING**: Does not extend base tsconfig
  - **Current State**: tsconfig.json uses standalone config
  - **Impact**: Doesn't inherit shared settings, harder to maintain
  - **Recommendation**: Extend `@tanstack/ts-config/tsconfig.app.json` for consistency

- ⚠️ **WARNING**: Uses path mapping to framework
  - **Current State**: tsconfig.json:16-20 has paths to framework source
  - **Better Approach**: Remove paths, rely on development exports in @sweatpants/framework

#### Recommended Changes (Optional)
Extending base config for consistency (not required for functionality):
```json
{
  "extends": "@tanstack/ts-config/tsconfig.app.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "ink": ["./node_modules/ink"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
**Note**: Path mapping to framework can be removed once framework has development exports working.

---

### 8. yo-mcp (Application - Bundler-Based)

**Location**: `/apps/yo-mcp`
**Build Tool**: tsup (package.json build script)

#### Status
⚠️ **Exempt from Composite** (see [Bundler-Based Applications](#bundler-based-applications-special-considerations))

#### What's Working
- ✅ **Workspace Dependency**: `@sweatpants/framework` declared (package.json:21)
- ✅ **Extends base config**: tsconfig.app.json → tsconfig.base.json (tsconfig.json:2)
- ✅ **Inherits noEmit**: From tsconfig.app.json (correct for bundler workflow)
- ✅ **Has check script**: `tsc --noEmit` for type checking (package.json:13)
- N/A **Development Exports**: Not needed for applications
- N/A **Composite Mode**: Exempt - uses tsup for builds

#### Issues
- ⚠️ **WARNING**: Uses path mapping to framework subpaths
  - **Current State**: tsconfig.json:5-12 has paths to framework source
  - **Better Approach**: Remove paths once framework has development exports for these subpaths

#### Current Config (Acceptable)
The current configuration is appropriate for a bundler-based app:
```json
{
  "extends": "@tanstack/ts-config/tsconfig.app.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@sweatpants/framework/chat/mcp-tools": [
        "../../packages/framework/src/lib/chat/mcp-tools/index.ts"
      ],
      "@sweatpants/framework/chat/isomorphic-tools": [
        "../../packages/framework/src/lib/chat/isomorphic-tools/index.ts"
      ]
    }
  },
  "include": ["src/**/*"]
}
```
**Note**: Path mappings can be removed once framework exports these subpaths with development conditions.

---

### 9. yo-slides (Presentation - Non-TypeScript)

**Location**: `/apps/yo-slides`

#### Status
✅ **N/A - Exempt**

#### Analysis
- **Type**: Slidev presentation application
- **TypeScript**: Not used (no tsconfig.json)
- **Workspace Dependencies**: None to @sweatpants packages

#### Recommendation
- **Exclude from root references**: This workspace should NOT be included in root tsconfig.json references since it has no TypeScript
- **Update root tsconfig.json**: Remove `{ "path": "./apps/yo-slides" }` from references array

---

### 10. @tanstack/ts-config

**Location**: `/packages/ts-config`

#### Status
✅ **Exempt - Config Only**

#### What's Working
- ✅ **Base configs are excellent**: All necessary settings present
- ✅ **declarationMap**: Set in base (tsconfig.base.json:17)
- ✅ **outDir**: Set in package config (tsconfig.package.json:9)
- ✅ **No TypeScript code**: Contains only JSON configuration files

#### Analysis
This is a config-only package with no TypeScript source code to compile. It should **NOT** be part of the `tsc -b` build chain.

#### Rationale for Exclusion
- **No source files**: Only contains tsconfig.*.json files
- **No build outputs**: Doesn't generate .js, .d.ts, or .tsbuildinfo files
- **Not a dependency**: Other workspaces `extend` these configs, they don't `import` from them
- **TypeScript doesn't require it**: Project references are only for code dependencies

#### Required Changes
**None** - This workspace should be excluded from root tsconfig.json references

---

## Summary by Requirement

### tsc-Buildable Workspaces (4 total)
Root, elicit-context, cli, framework, hydra

| Requirement | Compliant | Non-Compliant |
|------------|-----------|---------------|
| Development Exports | framework (1/4 packages) | elicit-context, cli, (hydra?) |
| TSConfig References | 0/4 | All 4 workspaces |
| Composite Mode | 0/4 | All 4 workspaces |
| Declaration | 4/4 (inherited) | - |
| **declarationMap** | 4/4 (inherited) | - |
| **outDir explicit** | 3/4 | 1/4 (framework - should add for safety) |
| **Export Ordering** | framework (1/1) | - |

### Bundler-Based Apps (3 total - Exempt from Composite)
yo-agent, yo-chat, yo-mcp

| Requirement | Status |
|------------|--------|
| Workspace Dependencies | ✅ All properly declared |
| Extends base config | ⚠️ yo-agent uses standalone config |
| noEmit mode | ✅ Correct for bundler workflow |
| Type check scripts | ✅ All have `check` script |

### Excluded (2 total)
- **ts-config** - Config-only package (no TypeScript source code)
- **yo-slides** - No TypeScript (Slidev presentations)

---

## Priority Fixes

### P0 - Blocks All Functionality (tsc-Buildable Workspaces Only)
1. Add `composite: true` to tsc-buildable workspace tsconfig.json files:
   - packages/elicit-context
   - packages/cli
   - packages/framework
   - apps/hydra
2. Add `references` to root tsconfig.json (4 workspaces, exclude ts-config, bundler apps, and yo-slides)
3. Add development exports to elicit-context and cli

### P1 - Enables Incremental Builds
4. Add `references` arrays to workspaces that have dependencies:
   - packages/framework → elicit-context
5. Explicitly set `outDir` in framework and hydra (defensive)

### P2 - Optional Improvements
6. yo-agent: Extend base config for consistency (not blocking)
7. Document the `tsc -b` workflow
8. Run verification tests from comment
9. Add troubleshooting guide

### Not Required
- ~~ts-config~~: Config-only package, no TypeScript source code
- ~~yo-agent, yo-chat, yo-mcp~~: Bundler-based apps exempt from composite mode
- ~~yo-slides~~: No TypeScript

---

## Acceptance Criteria Assessment

| AC | Description | Status | Blockers |
|----|-------------|--------|----------|
| AC1 | Edit in VSCode with IntelliSense without build | ❌ | Missing dev exports, composite, references |
| AC2 | Make changes without rebuilding dependencies | ❌ | Missing composite and references |
| AC3 | Incremental builds with `tsc --build` | ❌ | Missing composite and references |
| AC4 | dist only for publishing, not development | ❌ | Missing dev exports |

**All acceptance criteria are currently blocked.**

---

## Verification Plan (from comment)

After implementing fixes, run these tests:

```bash
# 1. Clean any existing build artifacts
pnpm tsc -b --clean

# 2. Incremental build should succeed
pnpm tsc -b
# Expected: Builds complete, .tsbuildinfo files created

# 3. Verify VSCode IntelliSense (manual)
# - Open file importing from another workspace
# - Hover over imported symbol → should show type info
# - Cmd/Ctrl+Click on symbol → should navigate to .ts source (not .d.ts)

# 4. Verify change detection
# - Modify a type in @sweatpants/elicit-context
# - Run `pnpm tsc -b` again
# - Expected: Only dependent projects rebuild

# 5. Fresh clone test
git clone <repo> fresh-test && cd fresh-test
pnpm install
# Open in VSCode - IntelliSense should work immediately
```

---

## Troubleshooting Guide (from comment)

| Error | Cause | Solution |
|-------|-------|----------|
| Referenced project must have setting 'composite': true | Missing composite flag | Add `"composite": true` to referenced tsconfig |
| Cannot find module '@sweatpants/...' | Missing workspace dependency or development export | Verify package.json has workspace dependency and development export |
| Go to Definition opens `.d.ts` file | Missing declarationMap | Add `"declarationMap": true` (already in base config) |
| error TS6305: Output file has not been built | outDir not set | Add explicit `"outDir": "./dist"` |

---

## Positive Notes

1. **Base configs are excellent**: The @tanstack/ts-config package already has all the correct compiler options
2. **Framework is close**: Already has development exports properly ordered
3. **Dependencies are tracked**: Workspace dependencies are properly declared in package.json
4. **No breaking changes**: All fixes are additive, no removal needed

---

## Next Steps

1. Review this updated compliance report
2. Implement P0 fixes (composite, references, dev exports)
3. Implement P1 fixes (workspace references, explicit outDirs)
4. Run full verification suite
5. Create policy document for future workspaces
