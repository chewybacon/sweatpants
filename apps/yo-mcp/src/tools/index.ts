/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 * All tools use the new createMcpTool API with .elicits() pattern.
 */
import type { McpRuntimeTool, ElicitsMap } from '@sweatpants/framework/chat/mcp-tools'

// Import all tools
import { echoTool } from './echo'
import { pickCardTool } from './pick-card'
import { greetTool } from './greet'
import { confirmTool } from './confirm'

// Export individual tools
export { echoTool } from './echo'
export { pickCardTool } from './pick-card'
export { greetTool } from './greet'
export { confirmTool } from './confirm'

/**
 * All available tools
 */
export const allTools: McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>[] = [
  echoTool as McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  pickCardTool as McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  greetTool as McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  confirmTool as McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>,
]

/**
 * Tools map (for handler)
 */
export function createToolsMap(): Map<string, McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>> {
  const map = new Map<string, McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
  for (const tool of allTools) {
    map.set(tool.name, tool)
  }
  return map
}
