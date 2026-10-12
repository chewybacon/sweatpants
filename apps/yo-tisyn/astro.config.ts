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
    plugins: [stylex.vite({ useCSSLayers: true }), clientContractPlugin()],
    build: { minify: true },
    ssr: {
      noExternal: true,
      resolve: { mainFields: ["browser", "module", "jsnext:main", "jsnext"] },
    },
  },
});
