import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { clientContractPlugin } from "@sweatpants/vite-plugin";
export default defineConfig(({ mode }) => ({
  cacheDir: `node_modules/.vite-${mode}`,
  build: { minify: true },
  plugins: [
    ...(mode === "cloudflare"
      ? // Match yo-chat: the Worker must use the environment configured by ssr below.
        [
          cloudflare({
            viteEnvironment: { name: "ssr" },
            persistState: { path: ".wrangler/worker-state" },
          }),
        ]
      : []),
    clientContractPlugin(),
    react(),
  ],
  server: mode === "cloudflare" ? undefined : { proxy: { "/api/chat": "http://127.0.0.1:8102" } },
  ssr:
    mode === "cloudflare"
      ? {
          noExternal: true,
          resolve: { mainFields: ["browser", "module", "jsnext:main", "jsnext"] },
        }
      : undefined,
}));
