import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { clientContractPlugin, nodeWorkerPlugin } from "@sweatpants/vite-plugin";
import { imagetools } from "vite-imagetools";
const isProd = process.env["NODE_ENV"] === "production";
const nodeBuiltins = Array.from(new Set(builtinModules.flatMap((name) => [name, `node:${name}`])));
const externalPackages = ["marked", "shiki", "katex", "mermaid", "@earendil-works/pi-ai"];

// Workspace packages that should hot-reload in dev
// Note: No resolve.alias needed - framework package.json exports have
// "development" condition that Vite uses automatically in dev mode
const workspacePackages = [
  "@sweatpants/agent-host",
  "@sweatpants/durable-chat-runtime",
  "@sweatpants/chat-core",
  "@sweatpants/tool-session",
];

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
    // Derive browser-safe interaction contracts from statically imported authored tools.
    clientContractPlugin(),
    // Node.js worker_threads support with ?nodeWorker and ?modulePath imports.
    // Skipped under Vitest: its resolveId rewrites the worker id (appending
    // &importer=...), which defeats vitest's module mocking of the `?modulePath`
    // import and makes esbuild choke on the query-laden .ts path. Tests mock the
    // worker URL directly; real dev/prod builds keep the plugin.
    ...(process.env["VITEST"] ? [] : [nodeWorkerPlugin()]),
    // The devtools event bus binds a fixed auxiliary port; omit it from the
    // isolated Playwright server so it can run beside a developer instance.
    ...(process.env["PLAYWRIGHT_TEST_SERVER"] === "1" ? [] : [devtools()]),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    imagetools(),
    tanstackStart(),
    viteReact(),
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
    // Exclude Playwright e2e tests from Vitest.
    // The outside-in HTTP tier is excluded from the default (hermetic) run and
    // is run selectively via vitest.outside-in.config.ts.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/e2e/**",
      "**/outside-in/**",
      "**/*.external.acceptance.test.ts",
    ],
  },
});

export default config;
