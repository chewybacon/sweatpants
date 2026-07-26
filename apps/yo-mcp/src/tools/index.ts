/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 * All tools use the new createTool API with .elicits() pattern.
 */
import type { RuntimeTool } from "@sweatpants/core";

// Import all tools
import { echoTool } from "./echo";
import { pickCardTool } from "./pick-card";
import { greetTool } from "./greet";
import { confirmTool } from "./confirm";

// Export individual tools
export { echoTool } from "./echo";
export { pickCardTool } from "./pick-card";
export { greetTool } from "./greet";
export { confirmTool } from "./confirm";

/**
 * All available tools
 */
export const allTools: RuntimeTool[] = [echoTool, pickCardTool, greetTool, confirmTool];

/**
 * Tools map (for handler)
 */
export function createToolsMap(): Map<string, RuntimeTool> {
  const map = new Map<string, RuntimeTool>();
  for (const tool of allTools) {
    map.set(tool.name, tool);
  }
  return map;
}
