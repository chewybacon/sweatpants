/**
 * Tool Registry
 *
 * Export all available tools for the MCP server.
 * All tools use the new createTool API with .elicits() pattern.
 */
import type { RuntimeTool } from "@sweatpants/agent-sdk";

// Import all tools
import { echoTool } from "./echo";
import { pickCardTool } from "./pick-card";
import { greetTool } from "./greet";
import { confirmTool } from "./confirm";
import { planTripTool } from "./plan-trip";

// Export individual tools
export { echoTool } from "./echo";
export { pickCardTool } from "./pick-card";
export { greetTool } from "./greet";
export { confirmTool } from "./confirm";
export { planTripTool } from "./plan-trip";

/**
 * All available tools
 */
export const allTools: RuntimeTool[] = [
  echoTool,
  pickCardTool,
  greetTool,
  confirmTool,
  planTripTool,
];
