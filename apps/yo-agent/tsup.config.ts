import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  // Mark native modules and heavy dependencies as external
  // They will be resolved at runtime from node_modules
  external: [
    'vite',
    'lightningcss',
    'esbuild',
    // Node built-ins that shouldn't be bundled
    'fs',
    'path',
    'os',
    'child_process',
    'crypto',
    'events',
    'stream',
    'util',
    'url',
    'http',
    'https',
    'net',
    'tty',
    'assert',
    'buffer',
    'querystring',
    'zlib',
    'module',
    'worker_threads',
    'perf_hooks',
  ],
  // Don't bundle node_modules - resolve at runtime
  noExternal: [],
})
