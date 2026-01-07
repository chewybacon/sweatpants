/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 */

// Original MCP tools (MCPClientContext)
export { echoTool } from './echo'
export { pickCardTool } from './pick-card'
export { greetTool } from './greet'
export { confirmTool } from './confirm'

// Branch-based tools (BranchContext)
export { pickCardBranchTool } from './pick-card-branch'

import { echoTool } from './echo'
import { pickCardTool } from './pick-card'
import { greetTool } from './greet'
import { confirmTool } from './confirm'
import { pickCardBranchTool } from './pick-card-branch'

/**
 * Original MCP tools (using MCPClientContext)
 */
export const originalTools = [
  echoTool,
  pickCardTool,
  greetTool,
  confirmTool,
]

/**
 * Branch-based tools (using BranchContext)
 */
export const branchTools = [
  pickCardBranchTool,
]

/**
 * All available tools (for backwards compatibility)
 */
export const allTools = [
  ...originalTools,
]
