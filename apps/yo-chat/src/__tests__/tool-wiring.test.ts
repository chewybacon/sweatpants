// @vitest-environment node
import { readFileSync } from "node:fs";

import { run } from "effection";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("yo-chat tool wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("installs durable response-stream storage without a legacy crank runtime", async () => {
    vi.doMock("@/lib/shared-redis", () => ({
      getSharedRedisClient: async () => null,
    }));

    const { useTokenBufferStore } = await import("@sweatpants/framework/chat/durable-streams");
    const { setupYoChatDurableStreams } = await import("../server/durable-streams");

    await run(function* () {
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

    const { activePluginTools, pluginRegistry, mcpToolRegistry } = await import("../server/tools");
    const pluginNames = ["ask_question", "book_flight", "pick_card", "play_ttt", "tictactoe"];
    const ordinaryNames = ["ask_question", "book_flight", "play_ttt", "tictactoe"];

    const activeNames = activePluginTools.map((tool) => tool.name).sort();
    expect(activeNames).toEqual(ordinaryNames);
    expect(pluginRegistry.toolNames().sort()).toEqual(pluginNames);
    expect(mcpToolRegistry.names().sort()).toEqual(ordinaryNames);
  });

  it("excludes crank-native contracts from the ordinary generated worker", () => {
    const workerEntry = readFileSync(
      new URL("../__generated__/tool-worker.gen.ts", import.meta.url),
      "utf8",
    );

    expect(workerEntry).toContain("name: 'ask_question'");
    expect(workerEntry).not.toContain("name: 'pick_card'");
    expect(workerEntry).toContain("name: 'book_flight'");
    expect(workerEntry).toContain("name: 'play_ttt'");
    expect(workerEntry).toContain("name: 'tictactoe'");
  });
});
