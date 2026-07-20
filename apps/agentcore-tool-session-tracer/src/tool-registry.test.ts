// @vitest-environment node
import { describe, expect, it } from "vitest";

import { getRuntimeMcpTool, runtimeMcpToolNames } from "./tool-registry.ts";

const expectedTools = [
  "ask_question",
  "book_flight",
  "calculator",
  "tictactoe",
];

describe("AgentCore ordinary tool registry", () => {
  it("ships every AgentCore-compatible ordinary yo-chat tool", () => {
    expect(runtimeMcpToolNames()).toEqual(expectedTools);
  });

  it.each(expectedTools)("exposes bridge-compatible tool %s", (name) => {
    const tool = getRuntimeMcpTool(name);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(name);
    expect(tool?.parameters).toBeDefined();
  });

  it("omits crank-native programs from the ToolSession projection", () => {
    expect(getRuntimeMcpTool("pick_card")).toBeUndefined();
    expect(getRuntimeMcpTool("play_ttt")).toBeUndefined();
  });
});
