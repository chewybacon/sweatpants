# TypeScript Monorepo: Project References and Development Exports

This doc describes the setup used in this repo for TypeScript project references (`tsc -b`) and Node/TS package "development" exports.

**Related**: [Issue #1](https://github.com/chewybacon/sweatpants/issues/1), `policies/typescript-monorepo.md`

## Goals

- Enable fast incremental builds across buildable workspaces with `pnpm tsc -b`.
- Enable IDE navigation and IntelliSense without requiring pre-built `dist/`.
- Keep bundler-based apps (Vite/tsup) out of the `tsc -b` chain.

## Workspaces in the `tsc -b` chain

- Root
- `packages/elicit-context`
- `packages/cli`
- `packages/framework`
- `apps/hydra`

## Root `tsconfig.json`

- Root has a `references` array for build order.
- Root uses `files: []` so it does not compile sources directly.

## Package requirements

### Composite mode

Buildable packages enable `composite: true`.

Note: this repo’s shared base config uses `allowImportingTsExtensions: true` (bundler-style resolution). TypeScript only allows that when `noEmit` or `emitDeclarationOnly` is enabled, so the `tsc -b` packages set:

- `emitDeclarationOnly: true`

This keeps `tsc -b` focused on producing `.d.ts` + `.d.ts.map` outputs for tooling while bundlers handle runtime JS builds.

### References

If a package depends on another workspace package, add a `references` entry to track rebuilds.

## App requirements (hydra)

`apps/hydra` participates in the build chain with `composite: true`.

- `apps/hydra/docs` is excluded from the build program because it contains illustrative snippets that are not maintained as part of the build output.

## Bundler-based apps

Apps using Vite/tsup keep their existing workflows:

- Build via `pnpm run build`
- Type-check via `pnpm run check` (or equivalent)
- Not included in root `references`

## Verification

- Clean + build:
  - `pnpm tsc -b --clean && pnpm tsc -b`
- Change detection:
  - modify a file in `packages/elicit-context`
  - re-run `pnpm tsc -b`
  - only the changed package and dependents should rebuild
- IDE (manual):
  - remove `dist/` folders
  - confirm VSCode hovers and "Go to Definition" jump to `.ts` sources via `development` exports
