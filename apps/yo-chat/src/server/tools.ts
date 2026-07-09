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
import { env } from "@/env";
import { toolList } from "../__generated__/tool-registry.gen";
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

export const mcpPluginTools = pluginToolModules.map(({ tool }) => tool);

type NamedTool = { name: string };

/**
 * MCP plugin tools available to the AgentCore runtime, filtered at runtime via
 * the `AGENTCORE_TOOL_NAMES` env var. When unset, all MCP plugin tools are
 * supported. This is a runtime configuration concern — no codegen fork.
 */
const SUPPORTED_AGENTCORE_TOOL_NAMES: Set<string> | null = (() => {
  if (env.MCP_TOOL_RUNTIME !== "agentcore") return null;
  const configured = env.AGENTCORE_TOOL_NAMES?.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (!configured || configured.length === 0) return null; // unset = all supported
  return new Set(configured);
})();

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

/**
 * Resolve the AgentCore-supported tool names from runtime configuration.
 * When `AGENTCORE_TOOL_NAMES` is unset, all MCP plugin tools are supported.
 */
function configuredAgentCoreToolNames(): string[] {
  if (SUPPORTED_AGENTCORE_TOOL_NAMES === null) {
    return mcpPluginTools.map((tool) => tool.name);
  }
  return mcpPluginTools
    .map((tool) => tool.name)
    .filter((name) => SUPPORTED_AGENTCORE_TOOL_NAMES!.has(name));
}

function activeMcpPluginTools(): Array<(typeof mcpPluginTools)[number]> {
  if (env.MCP_TOOL_RUNTIME !== "agentcore") return mcpPluginTools;
  const configured = new Set(configuredAgentCoreToolNames());
  return mcpPluginTools.filter((tool) => configured.has(tool.name));
}

export function activeAgentCoreToolNames(): string[] {
  return configuredAgentCoreToolNames();
}

const pluginClients = pluginToolModules.map(({ plugin }) => plugin.client as any);
export const pluginRegistry = createPluginRegistryFrom(pluginClients);

export const activePluginTools = activeMcpPluginTools();
export const mcpToolRegistry = createToolRegistry(activePluginTools);

console.info("[yo-chat] active MCP plugin tools", {
  runtime: env.MCP_TOOL_RUNTIME,
  configuredAgentCoreToolNames:
    env.MCP_TOOL_RUNTIME === "agentcore" ? configuredAgentCoreToolNames() : [],
  availablePluginToolNames: mcpPluginTools.map((tool) => tool.name),
  activePluginToolNames: activePluginTools.map((tool) => tool.name),
});

export function* setupYoChatBaseContexts(): Operation<void> {
  yield* PersonaResolverContext.set(resolvePersona);
  yield* MaxIterationsContext.set(10);
  yield* PluginRegistryContext.set(pluginRegistry);
  yield* McpToolRegistryContext.set(mcpToolRegistry);
}
