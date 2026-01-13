import { createContext } from 'effection'

import type { ChatStreamOptions, ChatProvider } from './types.ts'
import type { IsomorphicTool } from '../../../handler/types.ts'
import type { PersonaResolver } from '../../../handler/types.ts'
import type { PluginRegistry } from '../mcp-tools/plugin-registry.ts'
import type { McpToolRegistry } from '../../../handler/durable/types.ts'
import type { ToolSessionStore } from '../mcp-tools/session/types.ts'

export const ChatStreamConfigContext = createContext<ChatStreamOptions>('ChatStreamOptions')
export const ChatApiKeyContext = createContext<string>('ChatApiKeyContext')

// DI contexts for hook-based configuration
export const ProviderContext = createContext<ChatProvider>('Provider')
export const ToolRegistryContext = createContext<IsomorphicTool[]>('ToolRegistry')
export const PersonaResolverContext = createContext<PersonaResolver>('PersonaResolver')
export const MaxIterationsContext = createContext<number>('MaxIterations')

// Plugin contexts for MCP plugin tool support
export const PluginRegistryContext = createContext<PluginRegistry>('PluginRegistry')
export const McpToolRegistryContext = createContext<McpToolRegistry>('McpToolRegistry')

/**
 * Context for the plugin tool session store.
 * 
 * This store persists plugin tool sessions across HTTP requests, enabling
 * multi-step elicitation flows where the tool suspends, the user responds
 * in a separate request, and the tool resumes.
 * 
 * Should be set once at server startup (or per-handler initialization) using
 * a shared store instance (e.g., createInMemoryToolSessionStore()).
 */
export const PluginSessionStoreContext = createContext<ToolSessionStore>('PluginSessionStore')

/**
 * Context for the plugin session registry.
 * 
 * The registry manages tool session lifecycles and must be created in a
 * long-lived scope (at server startup) to persist across HTTP requests.
 * This is critical for multi-step elicitation flows.
 * 
 * Should be set once at server startup:
 * ```typescript
 * const { registry } = await run(function* () {
 *   const store = createInMemoryToolSessionStore()
 *   const registry = yield* createToolSessionRegistry(store, { samplingProvider })
 *   return { registry }
 * })
 * ```
 */
export const PluginSessionRegistryContext = createContext<import('../mcp-tools/session/types').ToolSessionRegistry>('PluginSessionRegistry')

/**
 * Context for the plugin session manager.
 * 
 * The manager wraps the registry to provide session wrapper caching and
 * last-processed-LSN tracking. It must be created in a long-lived scope
 * to preserve session state across HTTP requests.
 * 
 * This is critical for multi-step elicitation - the manager tracks which
 * events have been processed so reconnecting clients don't see old events.
 */
export const PluginSessionManagerContext = createContext<import('../../../handler/durable/plugin-session-manager').PluginSessionManager>('PluginSessionManager')
