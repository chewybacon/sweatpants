# TypeScript Monorepo Policy

**Last Updated**: 2026-01-11
**Related**: [Issue #1](https://github.com/chewybacon/sweatpants/issues/1)

This policy defines the TypeScript configuration standards for the sweatpants monorepo. All workspaces must comply with these requirements to ensure proper IntelliSense, incremental builds, and developer experience.

---

## Table of Contents

1. [Workspace Categories](#workspace-categories)
2. [Requirements by Category](#requirements-by-category)
3. [Development Exports](#development-exports)
4. [TSConfig Standards](#tsconfig-standards)
5. [New Workspace Checklist](#new-workspace-checklist)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)

---

## Workspace Categories

Every workspace falls into one of three categories. Determine the category first before applying configuration.

### Category 1: tsc-Buildable Packages

**Definition**: Libraries/packages where TypeScript compiler (`tsc`) handles type declaration generation.

**Examples**: `@sweatpants/framework`, `@sweatpants/elicit-context`, `@sweatpants/cli`

**Characteristics**:
- Consumed by other workspaces via imports
- Need to generate `.d.ts` declaration files
- Participate in `tsc -b` incremental build chain
- Typically use tsup/esbuild for JS bundling, tsc for declarations

### Category 2: Bundler-Based Applications

**Definition**: Applications where an external bundler (tsup, vite, esbuild) handles the entire build.

**Examples**: `yo-agent` (tsup), `yo-chat` (vite), `yo-mcp` (tsup)

**Characteristics**:
- Leaf nodes - not imported by other workspaces
- Use `noEmit: true` - bundler handles all output
- Type-check via `tsc --noEmit`
- **Exempt from composite mode**

**Why exempt**: `composite: true` requires emit, but bundler workflows use `noEmit: true`. These are mutually exclusive. Additionally, `allowImportingTsExtensions: true` (common in bundler configs) only works with `noEmit: true`.

### Category 3: Non-TypeScript Workspaces

**Definition**: Workspaces with no TypeScript code.

**Examples**: `yo-slides` (Slidev presentations)

**Characteristics**:
- No tsconfig.json required
- Excluded from all TypeScript tooling

---

## Requirements by Category

### tsc-Buildable Packages (Category 1)

| Requirement | Required | Notes |
|-------------|----------|-------|
| `composite: true` | Yes | Enables project references |
| `emitDeclarationOnly: true` | Yes | tsc emits .d.ts only, bundler handles JS |
| `outDir` | Yes | Must be explicitly set (typically `./dist`) |
| `references` array | Yes | List workspace dependencies |
| Development exports | Yes | Must be first condition in exports |
| Included in root references | Yes | Enables `tsc -b` from root |

### Bundler-Based Applications (Category 2)

| Requirement | Required | Notes |
|-------------|----------|-------|
| `composite: true` | No | Exempt - conflicts with noEmit |
| `noEmit: true` | Yes | Inherited from base config |
| `references` array | No | Not part of tsc -b chain |
| Development exports | No | Apps don't export |
| `check` script | Yes | Must have `tsc --noEmit` |
| Extend base config | Recommended | For consistency |
| Included in root references | No | Excluded from tsc -b |

### Non-TypeScript Workspaces (Category 3)

No TypeScript requirements apply.

---

## Development Exports

Development exports enable VSCode IntelliSense without pre-building. They are **required for all tsc-buildable packages**.

### Format

```json
{
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
}
```

### Rules

1. **Order matters**: `development` MUST be the first condition
2. **Point to source**: Development condition points to `.ts` source files
3. **All subpaths**: Every exported subpath needs a development condition

### How It Works

```
[Consumer] --imports--> [@sweatpants/framework]
                              ↓
                    [development condition resolves to]
                              ↓
                    [./src/index.ts - actual source]
                              ↓
                    [VSCode IntelliSense works immediately]
```

### Subpath Exports

For packages with multiple entry points:

```json
{
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./vite": {
      "development": "./src/vite/index.ts",
      "types": "./dist/vite/index.d.ts",
      "import": "./dist/vite/index.js"
    }
  }
}
```

---

## TSConfig Standards

### tsc-Buildable Package Template

```json
{
  "extends": "@sweatpants/ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"],
  "references": [
    { "path": "../other-package" }
  ]
}
```

**Key settings**:
- `composite: true` - Enables project references
- `emitDeclarationOnly: true` - Only emit `.d.ts`, bundler handles JS
- `outDir` - Required with composite
- `references` - List all workspace dependencies

### Bundler-Based Application Template

```json
{
  "extends": "@sweatpants/ts-config/tsconfig.app.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Key settings**:
- Inherits `noEmit: true` from base
- No `composite` or `references`
- Path mappings for local aliases only

### Root tsconfig.json

```json
{
  "extends": "@sweatpants/ts-config/tsconfig.base.json",
  "compilerOptions": {
    "declaration": true
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

**Rules**:
- Only include tsc-buildable workspaces (Category 1)
- Exclude bundler-based apps (Category 2)
- Exclude non-TypeScript workspaces (Category 3)
- `files: []` prevents root from compiling

---

## New Workspace Checklist

### Adding a tsc-Buildable Package

- [ ] Create `tsconfig.json` with composite template above
- [ ] Set `composite: true`
- [ ] Set `emitDeclarationOnly: true`
- [ ] Set explicit `outDir: "./dist"`
- [ ] Add `references` for any workspace dependencies
- [ ] Add development exports to `package.json` (first condition!)
- [ ] Add to root `tsconfig.json` references array
- [ ] Verify with `pnpm tsc -b`

### Adding a Bundler-Based Application

- [ ] Create `tsconfig.json` extending appropriate base config
- [ ] Ensure `noEmit: true` is inherited (do NOT add composite)
- [ ] Add `check` script: `"check": "tsc --noEmit"`
- [ ] Declare workspace dependencies in `package.json`
- [ ] Do NOT add to root `tsconfig.json` references
- [ ] Verify with `pnpm check`

### Adding a Non-TypeScript Workspace

- [ ] No TypeScript configuration needed
- [ ] Do NOT add to root `tsconfig.json` references

---

## Verification

### Full Build Verification

```bash
# Clean and rebuild all tsc-buildable workspaces
pnpm tsc -b --clean
pnpm tsc -b

# Expected: Completes without errors
# Expected: .tsbuildinfo files created in each workspace's dist/
```

### Incremental Build Verification

```bash
# Make a change to a dependency
echo "// test" >> packages/elicit-context/src/index.ts

# Rebuild
pnpm tsc -b

# Expected: Only elicit-context and its dependents rebuild
# Expected: Unrelated workspaces show "up to date"
```

### VSCode IntelliSense Verification

1. Open a file that imports from another workspace
2. Hover over imported symbol → Should show type information
3. Cmd/Ctrl+Click on symbol → Should navigate to `.ts` source (not `.d.ts`)
4. Make a change in the dependency → IntelliSense should reflect immediately

### Fresh Clone Verification

```bash
git clone <repo> fresh-test
cd fresh-test
pnpm install
# Open in VSCode - IntelliSense should work immediately without build
```

---

## Troubleshooting

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Referenced project must have setting 'composite': true` | Missing composite flag | Add `"composite": true` to referenced workspace's tsconfig |
| `Cannot find module '@sweatpants/...'` | Missing dependency or development export | Check package.json has workspace dependency AND development export |
| Go to Definition opens `.d.ts` file | Missing declarationMap | Verify base config has `"declarationMap": true` (already set) |
| `error TS5096: Option 'allowImportingTsExtensions' can only be used when 'noEmit' is set` | Composite conflicts with base config | Add `"emitDeclarationOnly": true` to workspace tsconfig |
| `error TS6305: Output file has not been built` | outDir not set | Add explicit `"outDir": "./dist"` |

### Path Mappings vs Development Exports

**Path mappings** in tsconfig are a workaround when dependencies lack development exports:

```json
"paths": {
  "@sweatpants/framework/*": ["../../packages/framework/src/*"]
}
```

**These should be removed** once the dependency has proper development exports. Development exports are the preferred mechanism because:
- They work at runtime, not just compile time
- They're declared by the package, not the consumer
- They work consistently across all consumers

### When to Use Path Mappings

Only use path mappings for:
1. Local aliases within the same workspace (`@/*` → `./src/*`)
2. Temporary workarounds while migrating to development exports
3. Non-workspace dependencies that don't support development exports

---

## Type Checking Strategy

| Category | Command | When to Run |
|----------|---------|-------------|
| tsc-Buildable | `pnpm tsc -b` | CI, pre-commit, after dependency changes |
| Bundler Apps | `pnpm --filter <app> check` | CI, pre-commit |
| All | `pnpm -r check` | CI (runs all workspace check scripts) |

### CI Recommendations

```yaml
# Example CI step
- name: Type Check
  run: |
    pnpm tsc -b          # Check tsc-buildable workspaces
    pnpm -r run check    # Check all workspaces with check script
```

---

## Summary

1. **Categorize first**: Determine if workspace is tsc-buildable, bundler-based, or non-TS
2. **Development exports are key**: They enable IDE experience without builds
3. **Bundler apps are exempt**: Don't force composite mode on vite/tsup apps
4. **Root references are scoped**: Only include tsc-buildable workspaces
5. **Use `emitDeclarationOnly`**: Resolves allowImportingTsExtensions conflict elegantly
