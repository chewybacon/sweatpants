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
  noExternal: ["@sweatpants/agent-sdk", "@sweatpants/chat-core", "@sweatpants/tool-session"],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      "@sweatpants/agent-sdk/tool": resolve(here, "../../packages/agent-sdk/src/tool/index.ts"),
      "@sweatpants/agent-sdk": resolve(here, "../../packages/agent-sdk/src/index.ts"),
      "@sweatpants/react-chat/browser-rendering": resolve(
        here,
        "../../packages/react-chat/src/browser-rendering/index.ts",
      ),
      "@sweatpants/chat-core": resolve(here, "../../packages/chat-core/src/index.ts"),
      "@sweatpants/tool-session/mcp": resolve(here, "../../packages/tool-session/src/mcp/index.ts"),
    };
  },
});
