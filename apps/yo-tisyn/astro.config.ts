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
    persistState: { path: ".wrangler/worker-state" },
  }),
  integrations: [react()],
  vite: {
    // The child/direct experiment servers must not invalidate each other's optimizer files.
    cacheDir: `node_modules/.vite-${process.env.PUBLIC_TISYN_SAMPLING ?? "child"}`,
    define: {
      "process.env.PUBLIC_TISYN_SAMPLING": JSON.stringify(
        process.env.PUBLIC_TISYN_SAMPLING ?? "child",
      ),
    },
    plugins: [stylex.vite({ useCSSLayers: true }), clientContractPlugin()],
    build: { minify: true },
    ssr: {
      noExternal: true,
      resolve: { mainFields: ["browser", "module", "jsnext:main", "jsnext"] },
    },
  },
});
