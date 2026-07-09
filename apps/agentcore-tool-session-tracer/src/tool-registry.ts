import type { AnyToolDefinition } from "@sweatpants/core";
import { bookFlightTool } from "../../yo-chat/src/tools/book-flight/tool.ts";
import { playTttTool } from "../../yo-chat/src/tools/play-ttt/tool.ts";
import { tictactoeTool } from "../../yo-chat/src/tools/tictactoe/tool.ts";

type RuntimeMcpTool = AnyToolDefinition;

function isBridgeCompatibleTool(tool: unknown): tool is RuntimeMcpTool {
  if (typeof tool !== "function" || tool === null) return false;
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

const ALL_RUNTIME_TOOLS = [bookFlightTool, playTttTool, tictactoeTool] as const;

const SUPPORTED_TOOL_NAMES = new Set<string>(
  (process.env["AGENTCORE_TOOL_NAMES"] ?? "book_flight,play_ttt,tictactoe")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const runtimeTools = new Map<string, RuntimeMcpTool>();

for (const tool of ALL_RUNTIME_TOOLS) {
  const name = (tool as { name: string }).name;
  if (SUPPORTED_TOOL_NAMES.has(name)) {
    runtimeTools.set(name, assertRuntimeMcpTool(name, tool));
  }
}

export function getRuntimeMcpTool(name: string): RuntimeMcpTool | undefined {
  return runtimeTools.get(name);
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys()).sort();
}
