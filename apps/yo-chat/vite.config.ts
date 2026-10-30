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

const config = defineConfig(({ mode }) => {
  if (mode === "cloudflare" || mode === "d1-local") {
    throw new Error(
      "yo-chat remote deployment modes have been retired; use the local development server",
    );
  }
  return {
    cacheDir: `node_modules/.vite-${mode}`,
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    // Prevent Vite from pre-bundling workspace packages (allows HMR)
    optimizeDeps: {
      exclude: [...(isProd ? [] : workspacePackages), "wrangler"],
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

      ...(process.env["PLAYWRIGHT_TEST_SERVER"] === "1" || process.env["VITEST"]
        ? []
        : [devtools()]),
      viteTsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      imagetools(),
      // Start’s environment transforms split React from the jsdom renderer; unit tests need plain React.

      ...(process.env["VITEST"] ? [] : [tanstackStart()]),
      viteReact(),
    ],

    build: {
      rollupOptions: {
        // Browser renderer imports must become lazy chunks; SSR externals are above.
        external: ["@earendil-works/pi-ai", ...nodeBuiltins],
      },
    },

    // Enable nodeWorkerPlugin in dev mode for worker HMR
    worker: {
      plugins: () => [nodeWorkerPlugin()],
    },

    test: {
      // Real worker-thread acceptance fixtures are stable under the fork pool;
      // the default threads pool can lose Vitest task-update heartbeats during
      // long deterministic runtime-invariance tests.
      pool: "forks",
      fileParallelism: false,
      // Keep Node fetch and its abort primitives together while jsdom provides the DOM.
      environment: "../../scripts/testing/jsdom-with-node-fetch.ts",
      env: {
        DEFAULT_CHAT_MODEL_PROVIDER: process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? "github-copilot",
        DEFAULT_CHAT_MODEL_ID: process.env["DEFAULT_CHAT_MODEL_ID"] ?? "claude-sonnet-4.6",
      },
      // Exclude Playwright e2e tests from Vitest.
      exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    },
  };
});

export default config;
