import type { RuntimeTool } from "@sweatpants/core";
import { workerTools } from "../../yo-chat/src/server/worker-tools.ts";

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
      `AgentCore tool "${name}" is not MCP bridge-compatible: expected canonical core ToolDefinition`,
    );
  }
  return tool;
}

/** ToolSession projection consumes only the ordinary worker tool partition. */
const runtimeTools = new Map<string, RuntimeMcpTool>();
for (const tool of workerTools) {
  runtimeTools.set(tool.name, assertRuntimeMcpTool(tool.name, tool));
}

export function getRuntimeMcpTool(name: string): RuntimeMcpTool | undefined {
  return runtimeTools.get(name);
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys());
}
