import type { RuntimeTool } from "@sweatpants/core";
import { bookFlightTool } from "../../yo-chat/src/tools/book-flight/tool.ts";
import { calculator } from "../../yo-chat/src/tools/calculator.ts";
import { askQuestion } from "../../yo-chat/src/tools/general/ask-question/tool.ts";
import { playTttTool } from "../../yo-chat/src/tools/play-ttt/tool.ts";
import { tictactoeTool } from "../../yo-chat/src/tools/tictactoe/tool.ts";

type RuntimeMcpTool = RuntimeTool;

function isBridgeCompatibleTool(tool: unknown): tool is RuntimeMcpTool {
  if (typeof tool !== "function" || tool === null) {
    return false;
  }
  return "parameters" in tool && "capabilities" in tool && "schemas" in tool;
}

function assertRuntimeMcpTool(name: string, tool: unknown): RuntimeMcpTool {
  if (!isBridgeCompatibleTool(tool)) {
    throw new Error(
      `Generated AgentCore tool "${name}" is not MCP bridge-compatible: expected canonical core ToolDefinition or execute`,
    );
  }
  return tool as RuntimeMcpTool;
}

const ALL_RUNTIME_TOOLS = [
  askQuestion,
  bookFlightTool,
  calculator,
  playTttTool,
  tictactoeTool,
] as const;

const runtimeTools = new Map<string, RuntimeMcpTool>();
for (const tool of ALL_RUNTIME_TOOLS) {
  runtimeTools.set(tool.name, assertRuntimeMcpTool(tool.name, tool));
}

export function getRuntimeMcpTool(name: string): RuntimeMcpTool | undefined {
  return runtimeTools.get(name);
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys());
}
