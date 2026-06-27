import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { frameworkPlugin, nodeWorkerPlugin } from "@sweatpants/vite-plugin";
import { imagetools } from "vite-imagetools";
const isProd = process.env["NODE_ENV"] === "production";
const nodeBuiltins = Array.from(new Set(builtinModules.flatMap((name) => [name, `node:${name}`])));
const externalPackages = ["marked", "shiki", "katex", "mermaid", "@earendil-works/pi-ai"];

const agentCoreToolDiscovery = {
  dir: "src/tools",
  outFile: "src/__generated__/tool-registry.gen.ts",
  pattern: "**/*.{ts,tsx}",
  generateWorker: true,
  workerOutFile: "src/__generated__/tool-worker.gen.ts",
};

// Workspace packages that should hot-reload in dev
// Note: No resolve.alias needed - framework package.json exports have
// "development" condition that Vite uses automatically in dev mode
const workspacePackages = ["@sweatpants/framework"];

const config = defineConfig({
  // Prevent Vite from pre-bundling workspace packages (allows HMR)
  optimizeDeps: {
    exclude: isProd ? [] : workspacePackages,
  },

  // SSR: Don't externalize workspace packages so they get processed
  ssr: {
    noExternal: isProd ? [] : workspacePackages,
    external: [...externalPackages, ...nodeBuiltins],
  },

  plugins: [
    // Node.js worker_threads support with ?nodeWorker and ?modulePath imports
    nodeWorkerPlugin(),
    devtools(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
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
      external: [...externalPackages, ...nodeBuiltins],
    },
  },

  // Enable nodeWorkerPlugin in dev mode for worker HMR
  worker: {
    plugins: () => [nodeWorkerPlugin()],
  },

  test: {
    // Use jsdom for DOM testing with Interactors
    environment: "jsdom",
    env: {
      DEFAULT_CHAT_MODEL_PROVIDER: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
      DEFAULT_CHAT_MODEL_ID: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-4.5",
    },
    // Exclude Playwright e2e tests from Vitest
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
});

export default config;
