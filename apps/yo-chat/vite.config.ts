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
const workspacePackages = ['@tanstack/framework', '@tanstack/start-env']

// Resolve paths relative to this config file
const packagesDir = path.resolve(__dirname, '../../packages')

const config = defineConfig({
  base: isProd ? '/__BASE__/' : '/',
  
  resolve: isProd ? {} : {
    alias: {
      // Framework package - point to source files in dev
      '@tanstack/framework/vite': path.join(packagesDir, 'framework/src/vite/index.ts'),
      '@tanstack/framework/handler': path.join(packagesDir, 'framework/src/handler/index.ts'),
      '@tanstack/framework/chat': path.join(packagesDir, 'framework/src/lib/chat/index.ts'),
      '@tanstack/framework/chat/isomorphic-tools': path.join(packagesDir, 'framework/src/lib/chat/isomorphic-tools/index.ts'),
      '@tanstack/framework/react/chat': path.join(packagesDir, 'framework/src/react/chat/index.ts'),
      
      // Start-env package - point to source files in dev
      '@tanstack/start-env/vite': path.join(packagesDir, 'start-env/src/vite/index.ts'),
      '@tanstack/start-env/server': path.join(packagesDir, 'start-env/src/server.ts'),
      '@tanstack/start-env/client': path.join(packagesDir, 'start-env/src/client.ts'),
      '@tanstack/start-env': path.join(packagesDir, 'start-env/src/server.ts'),
    },
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
  }
})

export default config
