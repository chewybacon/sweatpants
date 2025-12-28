import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    vite: 'src/vite/index.ts',
    handler: 'src/handler/index.ts',
    chat: 'src/lib/chat/index.ts',
    'chat/isomorphic-tools': 'src/lib/chat/isomorphic-tools/index.ts',
    'react/chat': 'src/react/chat/index.ts',
    'react/chat/pipeline': 'src/react/chat/pipeline/index.ts',
  },
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
