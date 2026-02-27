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
  dts: true,
  clean: true,
  sourcemap: true,
})
