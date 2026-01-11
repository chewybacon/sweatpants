import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  tsconfig: '../ts-config/tsconfig.tsup.json',
  dts: {
    resolve: true,
  },
  sourcemap: true,
  clean: true,
  target: 'node20',
  banner: {
    js: '#!/usr/bin/env node',
  },
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
