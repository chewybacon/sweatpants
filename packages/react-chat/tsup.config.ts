import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pipeline: 'src/pipeline/index.ts',
  },
  tsconfig: '../ts-config/tsconfig.tsup.json',
  format: ['cjs', 'esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['@sweatpants/framework', 'react', 'effection', '@effectionx/raf', 'marked', 'shiki', 'mermaid', 'katex', 'tailwind-merge'],
  treeshake: true,
  skipNodeModulesBundle: true,
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
