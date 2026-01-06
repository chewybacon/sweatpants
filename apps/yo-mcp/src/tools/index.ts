/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 */
export { echoTool } from './echo'
export { pickCardTool } from './pick-card'
export { greetTool } from './greet'
export { confirmTool } from './confirm'

import { echoTool } from './echo'
import { pickCardTool } from './pick-card'
import { greetTool } from './greet'
import { confirmTool } from './confirm'

/**
 * All available tools
 */
export const allTools = [
  echoTool,
  pickCardTool,
  greetTool,
  confirmTool,
]
