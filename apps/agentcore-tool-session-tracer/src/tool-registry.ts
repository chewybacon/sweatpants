import type { McpRuntimeTool } from "../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-builder.ts";
import type { ElicitsMap } from "../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts";
import { toolList } from "../../yo-chat/src/__generated__/tool-registry.gen.ts";

type RuntimeMcpTool = McpRuntimeTool<
  string,
  unknown,
  unknown,
  unknown,
  unknown,
  ElicitsMap
>;

type BridgeCompatibleTool = {
  execute?: unknown;
  handoffConfig?: unknown;
};

function isBridgeCompatibleTool(tool: unknown): tool is BridgeCompatibleTool {
  if (typeof tool !== "object" || tool === null) return false;
  return "execute" in tool || "handoffConfig" in tool;
}

function assertRuntimeMcpTool(name: string, tool: unknown): RuntimeMcpTool {
  if (!isBridgeCompatibleTool(tool)) {
    throw new Error(
      `Generated AgentCore tool "${name}" is not MCP bridge-compatible: expected execute or handoffConfig`,
    );
  }
  return tool as RuntimeMcpTool;
}

/**
 * Supported AgentCore tool names, filtered at runtime via the
 * `AGENTCORE_TOOL_NAMES` environment variable. When unset, defaults to the
 * Batch-1 bridge-compatible tools. This is a runtime configuration concern —
 * no codegen fork.
 */
const SUPPORTED_TOOL_NAMES = new Set<string>(
  (process.env["AGENTCORE_TOOL_NAMES"] ?? "book_flight,play_ttt,tictactoe")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const runtimeTools = new Map<string, RuntimeMcpTool>();

for (const tool of toolList) {
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
