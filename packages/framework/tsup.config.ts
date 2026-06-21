import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/lib/chat/index.ts',
    server: 'src/server/index.ts',
    chat: 'src/lib/chat/index.ts',
    'chat/durable-streams': 'src/lib/chat/durable-streams/index.ts',
    'chat/isomorphic-tools': 'src/lib/chat/isomorphic-tools/index.ts',
    'chat/mcp-tools': 'src/lib/chat/mcp-tools/index.ts',
  },
  tsconfig: '../ts-config/tsconfig.tsup.json',
  format: ['cjs', 'esm'],
  dts: {
    resolve: true,
  },
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['vite', 'effection', 'zod'],
  treeshake: true,
  skipNodeModulesBundle: true,
  // After bundling, emit unbundled .d.ts with maps for go-to-source
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
