import type { RuntimeTool } from "@sweatpants/core";
import { ordinaryTools } from "../../yo-chat/src/__generated__/tool-registry.gen.ts";

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
  return tool;
}

/** ToolSession projection consumes only the generated ordinary partition. */
const runtimeTools = new Map<string, RuntimeMcpTool>();
for (const [name, tool] of Object.entries(ordinaryTools)) {
  runtimeTools.set(name, assertRuntimeMcpTool(name, tool));
}

export function getRuntimeMcpTool(name: string): RuntimeMcpTool | undefined {
  return runtimeTools.get(name);
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys());
}
