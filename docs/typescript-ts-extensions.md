# TypeScript `.ts` Extensions in Backend/Library Code

**Last Updated:** January 11, 2026  
**Status:** ✅ Implemented  
**Related:** `typescript-monorepo-references.md`, `policies/typescript-monorepo.md`

## Overview

This document explains how backend and library packages in the sweatpants monorepo use explicit `.ts` file extensions in imports while maintaining TypeScript project references and successful builds.

## Goals

1. ✅ Use explicit `.ts` extensions in all backend/library source code imports
2. ✅ Enable TypeScript `composite: true` for project references
3. ✅ Support tsup bundling with proper DTS generation
4. ✅ Maintain consistent developer experience across packages
5. ✅ Future-proof for ES modules and modern tooling

## Affected Packages

| Package | Type | Uses `.ts` Extensions | Rationale |
|---------|------|----------------------|-----------|
| `@sweatpants/framework` | Mixed (backend + React) | ✅ YES | Bundled by tsup, consistent DX |
| `@sweatpants/elicit-context` | Backend library | ✅ YES | Data transformation, server-side |
| `@sweatpants/cli` | Backend (Node.js) | ✅ YES | CLI tool, Node.js only |
| Future frontend apps | Frontend (React) | ❌ NO | Standard bundler practice |

## Architecture: Dual TypeScript Configuration

Each backend/library package uses **two separate TypeScript configurations** for different purposes:

### 1. Main `tsconfig.json` (Project References & Type Checking)

**Purpose:** TypeScript project references, IDE support, type checking

**Used by:**
- IDE (VSCode, IntelliSense)
- `tsc --emitDeclarationOnly` (in `onSuccess` hook)
- TypeScript project references

**Key settings:**
```json
{
  "extends": "../ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,              // ✅ Enable project references
    "emitDeclarationOnly": true,    // Only emit .d.ts files
    "outDir": "./dist",
    "rootDir": "./src",
    "ignoreDeprecations": "5.0"
  }
}
```

**Inherits from base:**
- `moduleResolution: "bundler"` - Supports `.ts` extensions
- `allowImportingTsExtensions: true` - Allows `.ts` in imports

### 2. Shared `tsconfig.tsup.json` (tsup Bundling)

**Purpose:** tsup's internal bundling and DTS generation

**Used by:**
- tsup bundler (via `tsconfig` config option)

**Location:** `/packages/ts-config/tsconfig.tsup.json`

**Configuration:**
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "noEmit": true,              // tsup handles emit
    "composite": false,          // Not needed for bundling
    "ignoreDeprecations": "5.0"
  }
}
```

**Inherits from base:**
- `moduleResolution: "bundler"` - ✅ Correct for tsup
- `allowImportingTsExtensions: true` - ✅ Supports `.ts` imports
- All strict type checking settings
- `verbatimModuleSyntax: true` - Preserves module syntax

## Why `moduleResolution: "bundler"`?

Even though code runs on Node.js backend, we use `"bundler"` because:

| Strategy | Supports `.ts` Extensions | Use Case |
|----------|---------------------------|----------|
| `"node"` | ❌ NO | Legacy CommonJS |
| `"node16"` / `"nodenext"` | ❌ NO (requires `.js`) | Unbundled Node.js ESM |
| `"bundler"` | ✅ YES | **Bundled code (tsup, webpack, vite)** |

**Our workflow:**
```
Source (.ts files with .ts imports)
    ↓
tsup bundles (using "bundler" resolution)
    ↓
Output (.js files with .js imports)
    ↓
Node.js executes
```

The bundler transforms imports at build time, so the output is Node.js compatible.

### Why Not `"node16"` or `"nodenext"`?

These strategies require using `.js` extensions in source files even though the files are `.ts`:

```typescript
// ❌ With "node16" - confusing!
import { Foo } from './types.js'  // File is actually types.ts

// ✅ With "bundler" - clear!
import { Foo } from './types.ts'  // File is types.ts
```

Since we use tsup to bundle, we benefit from bundler-style resolution without the confusion.

## Build Process Flow

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: tsup runs                                       │
│   Config: tsconfig.tsup.json                            │
│   Action: Bundle src/*.ts → dist/*.js                   │
│   Result: dist/*.js + dist/*.js.map                     │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ Step 2: onSuccess hook                                  │
│   Command: tsc --emitDeclarationOnly                    │
│   Config: tsconfig.json (composite: true)               │
│   Action: Generate type definitions                     │
│   Result: dist/*.d.ts + dist/*.d.ts.map                 │
└─────────────────────────────────────────────────────────┘
```

### Why Two Steps?

1. **tsup** generates JavaScript bundles efficiently (ESM/CJS)
2. **tsc** generates type definitions with project reference support
3. This separation allows:
   - ✅ Fast bundling with tsup
   - ✅ Proper `composite: true` support for IDE
   - ✅ Source code uses `.ts` extensions
   - ✅ Output is Node.js compatible

## Package Configuration Examples

### Framework Package

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    vite: 'src/vite/index.ts',
    handler: 'src/handler/index.ts',
    // ... more entry points
  },
  tsconfig: '../ts-config/tsconfig.tsup.json',  // Use shared config
  format: ['cjs', 'esm'],
  dts: { resolve: true },
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
```

**`tsconfig.json`:**
```json
{
  "extends": "@sweatpants/ts-config/tsconfig.package.json",
  "compilerOptions": {
    "emitDeclarationOnly": true,
    "ignoreDeprecations": "5.0"
  },
  "references": [
    { "path": "./tsconfig.lib.json" },
    { "path": "./tsconfig.test.json" }
  ]
}
```

**`tsconfig.lib.json`:**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["**/__tests__/**", "**/*.test.ts"],
  "references": [{ "path": "../elicit-context" }]
}
```

### Elicit-Context Package

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  tsconfig: '../ts-config/tsconfig.tsup.json',
  dts: { resolve: true },
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
```

**`tsconfig.json`:**
```json
{
  "extends": "../ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "ignoreDeprecations": "5.0"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### CLI Package

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  tsconfig: '../ts-config/tsconfig.tsup.json',
  dts: { resolve: true },
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
```

**`tsconfig.json`:**
```json
{
  "extends": "../ts-config/tsconfig.package.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "ignoreDeprecations": "5.0"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

## Source Code Import Style

All backend/library code uses explicit `.ts` extensions:

### ✅ Correct Examples

```typescript
// Explicit .ts extension for TypeScript files
import { encodeElicitContext } from './encode.ts'
import { decodeElicitContext } from './decode.ts'
import type { JsonSchema } from './types.ts'

// Explicit /index.ts for directories with index files
import { createChatSession } from '../lib/chat/session/index.ts'

// Explicit .tsx for React components
import { ChatProvider } from './ChatProvider.tsx'

// Type-only imports also use .ts extension
import type { Message } from '../types.ts'
```

### ❌ Wrong Examples

```typescript
// Missing extension - will cause issues
import { encodeElicitContext } from './encode'

// Missing extension on type import
import type { JsonSchema } from './types'

// Using .js extension in source (not needed with bundler)
import { Foo } from './bar.js'
```

### Package Imports (No Extension)

```typescript
// ✅ Correct - package imports don't use extensions
import { z } from 'zod'
import { createSignal } from 'effection'
import { ChatProvider } from '@sweatpants/framework/react/chat'
```

## Benefits

1. ✅ **Explicit Module Resolution** - Clear what files are being imported
2. ✅ **ESM Ready** - Aligns with ES module standards
3. ✅ **Bundler Friendly** - Works with tsup, vite, webpack
4. ✅ **Consistent DX** - Same style across all backend packages
5. ✅ **Type Safety** - Project references work correctly
6. ✅ **IDE Support** - Go-to-definition, refactoring all work
7. ✅ **Future Proof** - Matches modern TypeScript best practices
8. ✅ **No Ambiguity** - Always clear which file is being imported

## Troubleshooting

### Error: "An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled"

**Cause:** TypeScript config doesn't have `allowImportingTsExtensions: true`

**Solution:** Check that your config extends `tsconfig.base.json` which sets this option.

```json
{
  "extends": "../ts-config/tsconfig.package.json",
  // This inherits allowImportingTsExtensions: true
}
```

### Error: "File is not listed within the file list of project"

**Cause:** Using `composite: true` with tsup's DTS generation in the same config

**Solution:** Use the dual-config approach:
- tsup uses `tsconfig.tsup.json` (no composite)
- tsc uses `tsconfig.json` (with composite)

```typescript
// tsup.config.ts
export default defineConfig({
  tsconfig: '../ts-config/tsconfig.tsup.json',  // No composite
  onSuccess: 'tsc --emitDeclarationOnly ...',   // Uses main tsconfig (with composite)
})
```

### Build succeeds but IDE shows errors

**Cause:** IDE using different tsconfig than build

**Solution:** Ensure your package's `tsconfig.json` is the default config at the package root.

```
packages/my-package/
  ├── tsconfig.json         ← IDE uses this
  ├── tsup.config.ts        ← References tsconfig.tsup.json
  └── src/
```

### Warning: "No inputs were found in config file"

**Cause:** The `onSuccess` tsc command runs on a tsconfig with `references` but no local `include` paths

**Impact:** Harmless warning, can be ignored

**Explanation:** The main tsconfig.json uses project references, so it doesn't directly include files. The tsc command in onSuccess still generates correct .d.ts files.

## Verification

After making changes, verify:

```bash
# Build all packages
pnpm -r build

# Check generated files exist
ls packages/*/dist/*.d.ts
ls packages/*/dist/*.d.ts.map
ls packages/*/dist/*.js

# Type check entire monorepo with project references
pnpm tsc -b

# Run tests
pnpm test
```

### Test Incremental Builds

```bash
# Clean all builds
pnpm tsc -b --clean

# Full build
pnpm tsc -b

# Change a package
echo "// test" >> packages/framework/src/handler/index.ts

# Incremental rebuild (should be much faster)
time pnpm tsc -b
```

## App Configuration (Frontend)

Frontend apps do NOT use `.ts` extensions and reference packages via TypeScript `references`:

```json
{
  "extends": "@sweatpants/ts-config/tsconfig.app.json",
  "compilerOptions": {
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]  // Local alias only
    }
  },
  "references": [
    { "path": "../../packages/framework/tsconfig.lib.json" }
  ]
}
```

See `typescript-monorepo-references.md` for more details on app configuration.

## Related Documentation

- `typescript-monorepo-references.md` - Project references setup
- `policies/typescript-monorepo.md` - Monorepo policies
- [TypeScript Handbook: Modules](https://www.typescriptlang.org/docs/handbook/modules.html)
- [TypeScript Handbook: Module Resolution](https://www.typescriptlang.org/docs/handbook/modules/theory.html#module-resolution)
- [tsup Documentation](https://tsup.egoist.dev/)

## Implementation History

- **2026-01-11**: Initial implementation
  - Created `tsconfig.tsup.json` shared configuration
  - Updated framework, elicit-context, cli packages
  - All packages use explicit `.ts` extensions
  - Builds passing: 709/716 tests passing
  - Commits: `a0cda0d`, `4dd1fef`, `748e656`, `6df0218`, `d6753af`, `3a65ff5`

## Future Considerations

### If Moving to Unbundled Node.js ESM

If in the future we want to run TypeScript directly on Node.js without bundling:

1. Switch to `moduleResolution: "node16"` or `"nodenext"`
2. Use `.js` extensions in source code (TypeScript requirement)
3. Remove tsup from build process
4. Use only `tsc` for both compilation and type generation

**Current approach (bundled) is recommended** for:
- ✅ Libraries distributed as packages
- ✅ Backend services deployed as bundles
- ✅ Maximum flexibility in deployment

### Adding New Backend/Library Packages

When creating a new backend or library package:

1. **Create tsconfig.json** with `composite: true`:
   ```json
   {
     "extends": "../ts-config/tsconfig.package.json",
     "compilerOptions": {
       "composite": true,
       "emitDeclarationOnly": true,
       "outDir": "./dist",
       "rootDir": "./src",
       "ignoreDeprecations": "5.0"
     }
   }
   ```

2. **Create tsup.config.ts** using shared config:
   ```typescript
   export default defineConfig({
     entry: ['src/index.ts'],
     tsconfig: '../ts-config/tsconfig.tsup.json',
     dts: { resolve: true },
     onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
   })
   ```

3. **Use `.ts` extensions** in all imports:
   ```typescript
   import { Foo } from './foo.ts'
   import { Bar } from './utils/index.ts'
   ```

4. **Add to root references** in `/tsconfig.json`:
   ```json
   {
     "references": [
       // ...
       { "path": "./packages/new-package" }
     ]
   }
   ```

## FAQ

### Q: Why not use `.js` extensions like Node.js ESM requires?

**A:** We use bundlers (tsup) that transform imports at build time. The `.ts` extensions in source are transformed to `.js` in the output. This gives us:
- ✅ Clear source code (import from `.ts` files)
- ✅ Node.js compatible output (`.js` imports)
- ✅ No confusion about file extensions

### Q: Will this work with Node.js native ESM?

**A:** Yes! The bundled output uses standard `.js` imports that work with Node.js ESM. The `.ts` extensions are only in source code.

### Q: What about tree-shaking?

**A:** tsup (built on esbuild) handles tree-shaking automatically. The `.ts` extensions don't affect this.

### Q: Can I use this with Deno or Bun?

**A:** Deno and Bun natively support `.ts` imports, so this approach works even better there. However, our bundled output (`.js`) works universally.

### Q: Do apps need `.ts` extensions too?

**A:** No. Frontend apps (Vite-based) use standard bundler practices without `.ts` extensions. Only backend/library packages use `.ts` extensions for consistency and clarity.
