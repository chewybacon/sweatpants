import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  tsconfig: '../ts-config/tsconfig.tsup.json',
  format: ['cjs', 'esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['vite', 'zod'],
  treeshake: true,
  skipNodeModulesBundle: true,
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
