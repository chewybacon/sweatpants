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
    process.env["AGENTCORE_TOOL_NAMES"] = "book_flight,tictactoe";
    const { runtimeMcpToolNames, getRuntimeMcpTool } = await import("./tool-registry.ts");

    const names = runtimeMcpToolNames();
    expect(names).toContain("book_flight");
    expect(names).toContain("tictactoe");
    expect(names).not.toContain("play_ttt");
    expect(names).not.toContain("calculator");

    expect(getRuntimeMcpTool("book_flight")).toBeDefined();
    expect(getRuntimeMcpTool("play_ttt")).toBeUndefined();
  });

  it("changing the env var changes the subset without code changes", async () => {
    process.env["AGENTCORE_TOOL_NAMES"] = "play_ttt";
    const { runtimeMcpToolNames } = await import("./tool-registry.ts");

    const names = runtimeMcpToolNames();
    expect(names).toEqual(["play_ttt"]);
    expect(names).not.toContain("tictactoe");
  });
});
