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
    // Concurrent provider experiments must not invalidate each other's modules.
    cacheDir: `node_modules/.vite-${[
      process.env.DEFAULT_CHAT_MODEL_PROVIDER ?? "opencode",
      process.env.DEFAULT_CHAT_MODEL_ID ?? "claude-haiku-5-5",
      process.env.WORKFLOW_LOCAL_STATE_PATH ?? "default",
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
