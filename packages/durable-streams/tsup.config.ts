import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    'in-memory-store': 'src/in-memory-store.ts',
    'protocol-headers': 'src/protocol-headers.ts',
    'read-transport': 'src/read-transport.ts',
    'mutation-transport': 'src/mutation-transport.ts',
    'sse-formatter': 'src/sse-formatter.ts',
  },
  format: ['esm'],
  dts: {
    // tsup's declaration bundler builds each entry independently. The package
    // tsconfig is composite for `tsc -b`, but composite mode makes those
    // per-entry declaration builds reject imported sibling source files as not
    // listed in the temporary project. Keep composite enabled for `pnpm check`
    // and disable it only for tsup's DTS bundle step.
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
})
