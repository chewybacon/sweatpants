// @vitest-environment node
import { readFileSync } from "node:fs";

import { run, useScope } from "effection";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("yo-chat tool wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("installs durable response-stream storage without a obsolete crank runtime", async () => {
    vi.doMock("@/lib/shared-redis", () => ({
      getSharedRedisClient: async () => null,
    }));

    const { installDurableStreamsOwner, useTokenBufferStore } =
      await import("@sweatpants/durable-chat-runtime/response-streams");
    const { setupYoChatDurableStreams } = await import("../server/durable-streams");

    await run(function* () {
      const scope = yield* useScope();
      yield* installDurableStreamsOwner({
        scope,
        register: () => undefined,
      });
      yield* setupYoChatDurableStreams();
      const store = yield* useTokenBufferStore<string>();
      expect(store).toBeDefined();
    });
  });

  it("keeps durable plugins client-visible but out of ordinary server registries", async () => {
    vi.doMock("@/env", () => ({
      env: {
        MCP_TOOL_RUNTIME: "local",
        AGENTCORE_TOOL_NAMES: undefined,
      },
    }));

    const { mcpPluginTools, mcpToolRegistry } = await import("../server/tools");
    const pluginNames = ["ask_question", "book_flight", "pick_card", "play_ttt", "tictactoe"];
    const ordinaryNames = ["ask_question", "book_flight", "tictactoe"];

    const activeNames = mcpPluginTools.map((tool) => tool.name).sort();
    expect(activeNames).toEqual(ordinaryNames);
    expect(pluginNames).toEqual(
      ["ask_question", "book_flight", "pick_card", "play_ttt", "tictactoe"].sort(),
    );
    expect(mcpToolRegistry.names().sort()).toEqual(ordinaryNames);
  });

  it("excludes crank-native contracts from the ordinary worker tool list", async () => {
    const { workerTools } = await import("../server/worker-tools");
    const workerNames = workerTools.map((tool) => tool.name).sort();

    expect(workerNames).toEqual(["ask_question", "book_flight", "calculator", "tictactoe"]);
    // Crank-native programs execute through the Program Runtime, never the
    // ordinary ToolSession worker.
    expect(workerNames).not.toContain("pick_card");
    expect(workerNames).not.toContain("play_ttt");
    for (const tool of workerTools) {
      expect(tool.execution).toBe("ordinary");
    }

    // The hand-authored worker entry runs exactly this list.
    const workerEntry = readFileSync(new URL("../server/tool-worker.ts", import.meta.url), "utf8");
    expect(workerEntry).toContain("runToolWorkerEntry([...workerTools])");
    expect(workerEntry).toContain('from "./worker-tools.ts"');
  });
});
