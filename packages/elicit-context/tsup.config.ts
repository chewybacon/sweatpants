import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  tsconfig: '../ts-config/tsconfig.tsup.json',
  dts: {
    resolve: true,
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
