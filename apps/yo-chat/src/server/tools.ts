import type { Operation } from "effection";
import {
  MaxIterationsContext,
  McpToolRegistryContext,
  PersonaResolverContext,
  PluginRegistryContext,
  resolvePersona,
} from "@sweatpants/framework/chat";
import { createPluginRegistryFrom } from "@sweatpants/framework/chat/mcp-tools";
import type { McpToolRegistry } from "@sweatpants/framework/server";
import { ordinaryTools, toolList } from "../__generated__/tool-registry.gen";
import { bookFlightPlugin, bookFlightTool } from "../tools/book-flight";
import { askQuestion, askQuestionPlugin } from "../tools/general/ask_question";
import { pickCard, pickCardPlugin } from "../tools/pick-card";
import { playTttPlugin, playTttTool } from "../tools/play-ttt";
import { tictactoePlugin, tictactoeTool } from "../tools/tictactoe";

export const allTools = [...toolList];

const pluginToolModules = [
  { tool: askQuestion, plugin: askQuestionPlugin },
  { tool: bookFlightTool, plugin: bookFlightPlugin },
  { tool: pickCard, plugin: pickCardPlugin },
  { tool: playTttTool, plugin: playTttPlugin },
  { tool: tictactoeTool, plugin: tictactoePlugin },
] as const;

export const mcpPluginTools = pluginToolModules
  .map(({ tool }) => tool)
  .filter((tool) => tool.execution === "ordinary");

type NamedTool = { name: string };

function createToolRegistry(mcpTools: NamedTool[]): McpToolRegistry {
  const map = new Map<string, unknown>();
  for (const tool of mcpTools) {
    map.set(tool.name, tool);
  }

  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    names: () => Array.from(map.keys()),
  };
}

/** Complete generated inventory sent to AgentCore when that runtime is selected. */
export function activeAgentCoreToolNames(): string[] {
  // No crank-native AgentCore ProgramDriver is installed yet; availability
  // projection omits durable contracts instead of routing an ordinary twin.
  return Object.values(ordinaryTools).map((tool) => tool.name);
}

const pluginClients = pluginToolModules.map(({ plugin }) => plugin.client);
export const pluginRegistry = createPluginRegistryFrom(pluginClients);

export const activePluginTools = mcpPluginTools;
export const mcpToolRegistry = createToolRegistry(activePluginTools);

console.info("[yo-chat] active MCP plugin tools", {
  availablePluginToolNames: mcpPluginTools.map((tool) => tool.name),
  activePluginToolNames: activePluginTools.map((tool) => tool.name),
});

export function* setupYoChatBaseContexts(): Operation<void> {
  yield* PersonaResolverContext.set(resolvePersona);
  yield* MaxIterationsContext.set(10);
  yield* PluginRegistryContext.set(pluginRegistry);
  yield* McpToolRegistryContext.set(mcpToolRegistry);
}
