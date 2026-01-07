/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 * All tools use the new createMcpTool API with .elicits() pattern.
 */
import type { FinalizedMcpToolWithElicits, ElicitsMap } from '@sweatpants/framework/chat/mcp-tools'

// Import all tools
import { echoTool } from './echo'
import { pickCardTool } from './pick-card'
import { greetTool } from './greet'
import { confirmTool } from './confirm'
import { pickCardBranchTool } from './pick-card-branch'

// Export individual tools
export { echoTool } from './echo'
export { pickCardTool } from './pick-card'
export { greetTool } from './greet'
export { confirmTool } from './confirm'
export { pickCardBranchTool } from './pick-card-branch'

/**
 * All available tools
 */
export const allTools: FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>[] = [
  echoTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  pickCardTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  greetTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  confirmTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>,
  pickCardBranchTool as FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>,
]

/**
 * Tools map (for handler)
 */
export function createToolsMap(): Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>> {
  const map = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>()
  for (const tool of allTools) {
    map.set(tool.name, tool)
  }
  return map
}
