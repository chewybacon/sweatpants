import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  tsconfig: '../ts-config/tsconfig.tsup.json',
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
