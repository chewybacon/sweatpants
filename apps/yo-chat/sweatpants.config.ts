import { defineConfig, definePrograms } from "@sweatpants/cli/config";

import { playTttTool } from "./src/tools/play-ttt/tool.ts";

export default defineConfig({
  app: { command: ["pnpm", "dev"] },
  programs: definePrograms({
    play_ttt: {
      program: playTttTool,
      source: { module: "src/tools/play-ttt/tool.ts", export: "playTttTool" },
    },
  }),
  development: {
    remote: {
      provider: "agentcore",
      environment: "dev",
      region: "us-east-1",
    },
  },
});
