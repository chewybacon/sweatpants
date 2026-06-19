import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { frameworkPlugin, nodeWorkerPlugin } from '@sweatpants/framework/vite'
import { imagetools } from "vite-imagetools";
const isProd = process.env['NODE_ENV'] === 'production'

const agentCoreToolDiscovery = {
  dir: 'src/tools',
  outFile: 'src/__generated__/tool-registry.gen.ts',
  pattern: '**/*.{ts,tsx}',
  generateWorker: true,
  workerOutFile: 'src/__generated__/tool-worker.gen.ts',
  generateAgentCoreRegistry: true,
  agentCoreOutFile: 'src/__generated__/agentcore-tool-registry.gen.ts',
  // Batch-1 AgentCore Runtime support is deliberately narrow and explicit:
  // only MCP bridge-compatible tools in this allowlist are imported into
  // the generated AgentCore registry.
  agentCoreSupportedToolNames: ['book_flight', 'play_ttt', 'tictactoe'],
}

// Workspace packages that should hot-reload in dev
// Note: No resolve.alias needed - framework package.json exports have
// "development" condition that Vite uses automatically in dev mode
const workspacePackages = ['@sweatpants/framework']

const config = defineConfig({
  // Prevent Vite from pre-bundling workspace packages (allows HMR)
  optimizeDeps: {
    exclude: isProd ? [] : workspacePackages,
  },

  // SSR: Don't externalize workspace packages so they get processed
  ssr: {
    noExternal: isProd ? [] : workspacePackages,
  },

  plugins: [
    // Node.js worker_threads support with ?nodeWorker and ?modulePath imports
    nodeWorkerPlugin(),
    devtools(),
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    imagetools(),
    tanstackStart(),
    viteReact(),
    // Tool discovery: scan src/tools/ and generate registry
    ...frameworkPlugin({
      tools: agentCoreToolDiscovery,
    }),
  ],

  build: {
    rollupOptions: {
      external: ['marked', 'shiki', 'katex', 'mermaid']
    }
  },

  // Enable nodeWorkerPlugin in dev mode for worker HMR
  worker: {
    plugins: () => [nodeWorkerPlugin()],
  },

  test: {
    // Use jsdom for DOM testing with Interactors
    environment: 'jsdom',
    // Exclude Playwright e2e tests from Vitest
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
  }
})

export default config
