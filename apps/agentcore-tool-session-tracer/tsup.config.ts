import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["bedrock-agentcore"],
  // The runtime image intentionally excludes workspace dist artifacts. Bundle
  // app-authored tools and the core builder so no workspace symlink resolves to
  // a missing /packages/*/dist file at container startup.
  noExternal: ["@sweatpants/framework", "@sweatpants/core"],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      "@sweatpants/core": resolve(here, "../../packages/core/src/index.ts"),
      "@sweatpants/framework/chat/browser-rendering": resolve(
        here,
        "../../packages/framework/src/lib/chat/browser-rendering/index.ts",
      ),
      "@sweatpants/framework/chat": resolve(here, "src/framework-chat-agentcore-shim.ts"),
    };
  },
});
