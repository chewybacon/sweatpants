import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', host: 'src/host.ts' },
  tsconfig: '../ts-config/tsconfig.tsup.json',
  format: ['cjs', 'esm'],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['@sweatpants/framework', 'effection', 'zod', '@aws-sdk/client-bedrock-agentcore', 'redis'],
  treeshake: true,
  skipNodeModulesBundle: true,
  onSuccess: 'tsc --emitDeclarationOnly --declarationMap --declaration --outDir dist',
})
