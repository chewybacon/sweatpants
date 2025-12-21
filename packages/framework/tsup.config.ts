import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    vite: 'src/vite/index.ts',
    handler: 'src/handler/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['vite', 'effection', 'zod'],
  treeshake: true,
  skipNodeModulesBundle: true,
})
