import { createContext } from 'effection'

import type { IsomorphicTool, PersonaResolver } from '../../handler/types.ts'
import type { PluginRegistry } from './mcp-tools/plugin-registry.ts'
import type { McpToolRegistry } from '../../handler/durable/types.ts'
import type { ToolSessionRegistry, ToolSessionStore } from './mcp-tools/session/types.ts'
import type { PluginSessionManager } from '../../handler/durable/plugin-session-manager.ts'

// DI contexts for hook-based chat configuration.
export const ToolRegistryContext = createContext<IsomorphicTool[]>('ToolRegistry')
export const PersonaResolverContext = createContext<PersonaResolver>('PersonaResolver')
export const MaxIterationsContext = createContext<number>('MaxIterations')

// Plugin contexts for MCP plugin tool support.
export const PluginRegistryContext = createContext<PluginRegistry>('PluginRegistry')
export const McpToolRegistryContext = createContext<McpToolRegistry>('McpToolRegistry')

/**
 * Context for the plugin tool session store.
 *
 * This store persists plugin tool sessions across HTTP requests, enabling
 * multi-step elicitation flows where the tool suspends, the user responds
 * in a separate request, and the tool resumes.
 */
export const PluginSessionStoreContext = createContext<ToolSessionStore>('PluginSessionStore')

/**
 * Context for the plugin session registry.
 *
 * The registry manages tool session lifecycles and must be created in a
 * long-lived scope (at server startup) to persist across HTTP requests.
 */
export const PluginSessionRegistryContext = createContext<ToolSessionRegistry>('PluginSessionRegistry')

/**
 * Context for the plugin session manager.
 *
 * The manager wraps the registry to provide session wrapper caching and
 * last-processed-LSN tracking. It must be created in a long-lived scope
 * to preserve session state across HTTP requests.
 */
export const PluginSessionManagerContext = createContext<PluginSessionManager>('PluginSessionManager')
