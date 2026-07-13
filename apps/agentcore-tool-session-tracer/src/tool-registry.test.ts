// @vitest-environment node
import { describe, expect, it } from "vitest";

import { getRuntimeMcpTool, runtimeMcpToolNames } from "./tool-registry.ts";

const expectedTools = [
  "ask_question",
  "book_flight",
  "calculator",
  "pick_card",
  "play_ttt",
  "tictactoe",
];

describe("AgentCore complete tool registry", () => {
  it("ships the complete yo-chat inventory as one runtime", () => {
    expect(runtimeMcpToolNames()).toEqual(expectedTools);
  });

  it.each(expectedTools)("exposes bridge-compatible tool %s", (name) => {
    const tool = getRuntimeMcpTool(name);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(name);
    expect(tool?.parameters).toBeDefined();
  });
});
