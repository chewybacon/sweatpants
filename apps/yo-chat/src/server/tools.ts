import type { Operation } from 'effection'
import {
  MaxIterationsContext,
  McpToolRegistryContext,
  PersonaResolverContext,
  PluginRegistryContext,
  ToolRegistryContext,
  resolvePersona,
} from '@sweatpants/framework/chat'
import { createPluginRegistryFrom } from '@sweatpants/framework/chat/mcp-tools'
import type { McpToolRegistry } from '@sweatpants/framework/server'
import { env } from '@/env'
import { toolList } from '../__generated__/tool-registry.gen'
import {
  agentCoreToolNames,
  normalizeAgentCoreToolName,
  normalizeAgentCoreToolNames,
  unsupportedAgentCoreToolNames,
} from '../__generated__/agentcore-tool-registry.gen'
import { bookFlightPlugin, bookFlightTool } from '../tools/book-flight'
import { playTttPlugin, playTttTool } from '../tools/play-ttt'
import { tictactoePlugin, tictactoeTool } from '../tools/tictactoe'

export const allTools = [...toolList]
export const mcpPluginTools = [bookFlightTool, tictactoeTool, playTttTool]

type NamedTool = { name: string }

function createMcpToolRegistry(mcpTools: NamedTool[]): McpToolRegistry {
  const map = new Map<string, unknown>()
  for (const tool of mcpTools) {
    if (env.MCP_TOOL_RUNTIME === 'agentcore') {
      const canonicalName = normalizeAgentCoreToolName(tool.name) ?? tool.name
      const canonicalTool = canonicalName === tool.name
        ? tool
        : { ...(tool as object), name: canonicalName }
      map.set(tool.name, canonicalTool)
      map.set(canonicalName, canonicalTool)
      continue
    }

    map.set(tool.name, tool)
  }

  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    names: () => Array.from(map.keys()),
  }
}

function rawConfiguredAgentCoreToolNames(): string[] {
  const override = env.AGENTCORE_TOOL_NAMES
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  return override && override.length > 0 ? override : agentCoreToolNames
}

function configuredAgentCoreToolNames(): string[] {
  const configured = rawConfiguredAgentCoreToolNames()
  const unsupported = unsupportedAgentCoreToolNames(configured)
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported AGENTCORE_TOOL_NAMES value(s): ${unsupported.join(', ')}. `
      + `Supported AgentCore tool names are: ${agentCoreToolNames.join(', ')}. `
      + 'Canonical intrinsic MCP names are preferred; supported generated aliases are accepted and normalized.'
    )
  }

  return normalizeAgentCoreToolNames(configured)
}

function activeMcpPluginTools(): Array<(typeof mcpPluginTools)[number]> {
  if (env.MCP_TOOL_RUNTIME !== 'agentcore') return mcpPluginTools
  const configured = new Set(configuredAgentCoreToolNames())
  return mcpPluginTools.filter((tool) => {
    const canonicalName = normalizeAgentCoreToolName(tool.name) ?? tool.name
    return configured.has(canonicalName)
  })
}

export function activeAgentCoreToolNames(): string[] {
  return configuredAgentCoreToolNames()
}

export function canonicalizeAgentCoreTool<T extends NamedTool>(tool: T): T {
  const canonicalName = normalizeAgentCoreToolName(tool.name) ?? tool.name
  return canonicalName === tool.name ? tool : { ...(tool as object), name: canonicalName } as T
}

const pluginClients = [bookFlightPlugin.client as any, tictactoePlugin.client as any, playTttPlugin.client as any]
export const pluginRegistry = createPluginRegistryFrom(
  env.MCP_TOOL_RUNTIME === 'agentcore'
    ? pluginClients.flatMap((plugin) => {
        const canonicalName = normalizeAgentCoreToolName(plugin.toolName)
        return canonicalName && canonicalName !== plugin.toolName
          ? [plugin, { ...plugin, toolName: canonicalName }]
          : [plugin]
      })
    : pluginClients,
)

export const activePluginTools = activeMcpPluginTools()
export const mcpToolRegistry = createMcpToolRegistry(activePluginTools)

console.info('[yo-chat] active MCP plugin tools', {
  runtime: env.MCP_TOOL_RUNTIME,
  configuredAgentCoreToolNames: env.MCP_TOOL_RUNTIME === 'agentcore'
    ? configuredAgentCoreToolNames()
    : rawConfiguredAgentCoreToolNames(),
  availablePluginToolNames: mcpPluginTools.map((tool) => tool.name),
  activePluginToolNames: activePluginTools.map((tool) => tool.name),
})

export function* setupYoChatBaseContexts(): Operation<void> {
  yield* ToolRegistryContext.set(allTools)
  yield* PersonaResolverContext.set(resolvePersona)
  yield* MaxIterationsContext.set(10)
  yield* PluginRegistryContext.set(pluginRegistry)
  yield* McpToolRegistryContext.set(mcpToolRegistry)
}
