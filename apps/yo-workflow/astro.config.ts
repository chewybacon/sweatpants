import { executionPlayground } from "./execution/plugin.mjs";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { unplugin as stylex } from "@stylexjs/unplugin";
import { clientContractPlugin } from "@sweatpants/vite-plugin";

export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({
    imageService: "passthrough",
    persistState: { path: process.env.WORKFLOW_LOCAL_STATE_PATH ?? ".wrangler/worker-state" },
  }),
  integrations: [react()],
  vite: {
    resolve: {
      alias: {
        "#scheme-reflect-wasm": new URL(
          "../../packages/scheme-runtime/generated/reflect.wasm",
          import.meta.url,
        ).pathname,
        "#scheme-wtf8-wasm": new URL(
          "../../packages/scheme-runtime/generated/wtf8.wasm",
          import.meta.url,
        ).pathname,
        "#execution-kernel-wasm": new URL(
          "../../.artifacts/hoot-composition/kernel.wasm",
          import.meta.url,
        ).pathname,
      },
    },
    // Concurrent provider experiments must not invalidate each other's modules.
    cacheDir: `node_modules/.vite-${[
      process.env.DEFAULT_CHAT_MODEL_PROVIDER ?? "opencode",
      process.env.DEFAULT_CHAT_MODEL_ID ?? "claude-haiku-5-5",
      process.env.WORKFLOW_LOCAL_STATE_PATH ?? "default",
      process.env.WORKFLOW_DEV_PORT ?? "direct",
    ]
      .map((value) => value.replace(/[^a-zA-Z0-9_-]/g, "_"))
      .join("-")}`,
    // Preserve Pi's lazy module paths; prebundle its Anthropic SDK for workerd.
    optimizeDeps: {
      exclude: ["@earendil-works/pi-ai"],
      include: ["@earendil-works/pi-ai > @anthropic-ai/sdk"],
    },
    plugins: [executionPlayground(), stylex.vite({ useCSSLayers: true }), clientContractPlugin()],
    build: { minify: true },
    ssr: {
      optimizeDeps: {
        exclude: ["@earendil-works/pi-ai"],
        include: ["@earendil-works/pi-ai > @anthropic-ai/sdk"],
      },
      noExternal: true,
      resolve: { mainFields: ["browser", "module", "jsnext:main", "jsnext"] },
    },
  },
});
