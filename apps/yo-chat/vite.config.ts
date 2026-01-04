import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { runtimeBasePlugin } from '@tanstack/start-env/vite'
import { frameworkPlugin } from '@tanstack/framework/vite'
import { imagetools } from "vite-imagetools";
import path from 'path'

const isProd = process.env['NODE_ENV'] === 'production'

// Workspace packages that should hot-reload in dev
const workspacePackages = ['@tanstack/framework']

// Resolve paths relative to this config file
const packagesDir = path.resolve(__dirname, '../../packages')

const config = defineConfig({
  base: isProd ? '/__BASE__/' : '/',

  resolve: isProd ? {} : {
    alias: [
      // Framework package - point to source files in dev
      // IMPORTANT: More specific paths must come BEFORE less specific ones
      { find: '@tanstack/framework/react/chat/pipeline', replacement: path.join(packagesDir, 'framework/src/react/chat/pipeline/index.ts') },
      { find: '@tanstack/framework/react/chat', replacement: path.join(packagesDir, 'framework/src/react/chat/index.ts') },
      { find: '@tanstack/framework/chat/isomorphic-tools', replacement: path.join(packagesDir, 'framework/src/lib/chat/isomorphic-tools/index.ts') },
      { find: '@tanstack/framework/chat/durable-streams', replacement: path.join(packagesDir, 'framework/src/lib/chat/durable-streams/index.ts') },
      { find: '@tanstack/framework/chat', replacement: path.join(packagesDir, 'framework/src/lib/chat/index.ts') },
      { find: '@tanstack/framework/handler/durable', replacement: path.join(packagesDir, 'framework/src/handler/durable/index.ts') },
      { find: '@tanstack/framework/handler', replacement: path.join(packagesDir, 'framework/src/handler/index.ts') },
      { find: '@tanstack/framework/vite', replacement: path.join(packagesDir, 'framework/src/vite/index.ts') },
    ],
  },

  // Prevent Vite from pre-bundling workspace packages (allows HMR)
  optimizeDeps: {
    exclude: isProd ? [] : workspacePackages,
  },

  // SSR: Don't externalize workspace packages so they get processed
  ssr: {
    noExternal: isProd ? [] : workspacePackages,
  },

  plugins: [
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
      tools: {
        dir: 'src/tools',
        outFile: 'src/__generated__/tool-registry.gen.ts',
        pattern: '**/*.{ts,tsx}',
      },
    }),
    // Post-build: transform __BASE__ placeholders to runtime variable lookups
    runtimeBasePlugin({
      transform: 'string',
      logLevel: 'normal',
    }),
  ],

  build: {
    rollupOptions: {
      external: ['marked', 'shiki', 'katex', 'mermaid']
    }
  },

  test: {
    // Use jsdom for DOM testing with Interactors
    environment: 'jsdom',
    // Exclude Playwright e2e tests from Vitest
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
  }
})

export default config
