import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  dts: false,
  external: ['bedrock-agentcore'],
  noExternal: ['@sweatpants/framework'],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@sweatpants/core': resolve(here, '../../packages/core/src/index.ts'),
      '@sweatpants/framework/chat/isomorphic-tools': resolve(here, '../../packages/framework/src/lib/chat/isomorphic-tools/index.ts'),
      '@sweatpants/framework/chat': resolve(here, 'src/framework-chat-agentcore-shim.ts'),
    }
  },
})
