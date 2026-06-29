// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("AgentCore runtime tool filtering", () => {
  const original = process.env["AGENTCORE_TOOL_NAMES"];

  beforeEach(() => {
    // Reset module cache so the env is re-read on import.
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["AGENTCORE_TOOL_NAMES"];
    } else {
      process.env["AGENTCORE_TOOL_NAMES"] = original;
    }
    vi.resetModules();
  });

  it("filters the single registry to the configured subset at runtime", async () => {
    process.env["AGENTCORE_TOOL_NAMES"] = "pick_card,start_ttt_game";
    const { runtimeMcpToolNames, getRuntimeMcpTool } = await import("./tool-registry.ts");

    const names = runtimeMcpToolNames();
    expect(names).toContain("pick_card");
    expect(names).toContain("start_ttt_game");
    expect(names).not.toContain("ttt_move");
    expect(names).not.toContain("calculator");

    expect(getRuntimeMcpTool("pick_card")).toBeDefined();
    expect(getRuntimeMcpTool("ttt_move")).toBeUndefined();
  });

  it("changing the env var changes the subset without code changes", async () => {
    process.env["AGENTCORE_TOOL_NAMES"] = "ttt_move";
    const { runtimeMcpToolNames } = await import("./tool-registry.ts");

    const names = runtimeMcpToolNames();
    expect(names).toEqual(["ttt_move"]);
    expect(names).not.toContain("start_ttt_game");
  });
});
