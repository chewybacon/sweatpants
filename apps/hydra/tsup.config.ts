import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
  minify: false,
  external: [
    // Peer dependencies - users must install these
    'effection',
    'express',
    'http-proxy',
  ],
  treeshake: true,
})
