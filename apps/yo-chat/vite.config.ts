import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { runtimeBasePlugin } from '@tanstack/start-env/vite'
import { frameworkPlugin } from '@tanstack/framework/vite'
import { imagetools } from "vite-imagetools";

const isProd = process.env.NODE_ENV === 'production'

const config = defineConfig({
  base: isProd ? '/__BASE__/' : '/',
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
      },
    }),
    // Post-build: transform __BASE__ placeholders to runtime variable lookups
    runtimeBasePlugin({
      transform: 'string',
      logLevel: 'normal',
    }),
  ],
})

export default config
