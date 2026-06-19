import type { FinalizedMcpToolWithElicits } from '../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-builder.ts'
import type { ElicitsMap } from '../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts'
import { agentCoreToolRegistry } from '../../yo-chat/src/__generated__/agentcore-tool-registry.gen.ts'

type RuntimeMcpTool = FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

type BridgeCompatibleTool = {
  execute?: unknown
  handoffConfig?: unknown
}

function isBridgeCompatibleTool(tool: unknown): tool is BridgeCompatibleTool {
  if (typeof tool !== 'object' || tool === null) return false
  return 'execute' in tool || 'handoffConfig' in tool
}

function assertRuntimeMcpTool(name: string, tool: unknown): RuntimeMcpTool {
  if (!isBridgeCompatibleTool(tool)) {
    throw new Error(`Generated AgentCore tool "${name}" is not MCP bridge-compatible: expected execute or handoffConfig`)
  }
  return tool as RuntimeMcpTool
}

const runtimeTools = new Map<string, RuntimeMcpTool>()

for (const entry of agentCoreToolRegistry) {
  const tool = assertRuntimeMcpTool(entry.name, entry.tool)
  runtimeTools.set(entry.name, tool)
  for (const alias of entry.aliases ?? []) {
    runtimeTools.set(alias, tool)
  }
}

export function getRuntimeMcpTool(name: string): RuntimeMcpTool | undefined {
  return runtimeTools.get(name)
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys()).sort()
}
