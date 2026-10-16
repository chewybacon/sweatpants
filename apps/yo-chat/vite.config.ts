import { builtinModules } from "node:module";
import { cloudflare } from "@cloudflare/vite-plugin";
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
  const isCloudflare = mode === "cloudflare";
  return {
    cacheDir: `node_modules/.vite-${mode}`,
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: isCloudflare
        ? [
            {
              find: /^.*\/chat-application(?:\.ts)?$/,
              replacement: new URL("./src/server/cloudflare-chat-application.ts", import.meta.url)
                .pathname,
            },
          ]
        : mode === "d1-local"
          ? [
              {
                find: /^\.\/storage-config$/,
                replacement: new URL("./src/server/local-d1-storage-config.ts", import.meta.url)
                  .pathname,
              },
              {
                find: /^\.\/durable-streams$/,
                replacement: new URL("./src/server/local-cloudflare-streams.ts", import.meta.url)
                  .pathname,
              },
            ]
          : [],
    },
    // Local workerd owns both the journal binding and metadata endpoints.
    server:
      mode === "d1-local"
        ? {
            proxy: {
              "/api/threaded-chat/threads": { target: "http://127.0.0.1:8788", changeOrigin: true },
            },
          }
        : undefined,
    // Prevent Vite from pre-bundling workspace packages (allows HMR)
    optimizeDeps: {
      exclude: [...(isProd ? [] : workspacePackages), "wrangler"],
    },

    // SSR: Don't externalize workspace packages so they get processed
    ssr: {
      // Honor SDK web-runtime mappings instead of bundling Node-only helpers into workerd.
      resolve: isCloudflare
        ? { mainFields: ["browser", "module", "jsnext:main", "jsnext"] }
        : undefined,
      noExternal: isCloudflare ? true : isProd ? [] : workspacePackages,
      external: isCloudflare ? [] : [...externalPackages, ...nodeBuiltins],
    },

    plugins: [
      ...(isCloudflare
        ? [
            cloudflare({
              viteEnvironment: { name: "ssr" },
              persistState: { path: ".wrangler/worker-state" },
            }),
          ]
        : []),
      // Derive browser-safe interaction contracts from statically imported authored tools.
      clientContractPlugin(),
      // Node.js worker_threads support with ?nodeWorker and ?modulePath imports.
      // Skipped under Vitest: its resolveId rewrites the worker id (appending
      // &importer=...), which defeats vitest's module mocking of the `?modulePath`
      // import and makes esbuild choke on the query-laden .ts path. Tests mock the
      // worker URL directly; real dev/prod builds keep the plugin.
      ...(process.env["VITEST"] || isCloudflare ? [] : [nodeWorkerPlugin()]),
      // The devtools event bus binds a fixed auxiliary port; omit it from the
      // isolated Playwright server so it can run beside a developer instance.
      ...(process.env["PLAYWRIGHT_TEST_SERVER"] === "1" || process.env["VITEST"] || isCloudflare
        ? []
        : [devtools()]),
      viteTsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      imagetools(),
      // Start’s environment transforms split React from the jsdom renderer; unit tests need plain React.
      ...(process.env["VITEST"]
        ? []
        : [tanstackStart(isCloudflare ? { server: { entry: "server.cloudflare" } } : {})]),
      viteReact(),
    ],

    build: {
      rollupOptions: {
        // Browser renderer imports must become lazy chunks; SSR externals are above.
        external: isCloudflare ? [] : ["@earendil-works/pi-ai", ...nodeBuiltins],
      },
    },

    // Enable nodeWorkerPlugin in dev mode for worker HMR
    worker: {
      plugins: () => (isCloudflare ? [] : [nodeWorkerPlugin()]),
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
  };
});

export default config;
