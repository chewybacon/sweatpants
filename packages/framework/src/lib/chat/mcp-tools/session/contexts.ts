/**
 * MCP Tool Session Contexts
 *
 * Effection contexts for dependency injection of session components.
 *
 * ## Usage
 *
 * @example Setup contexts
 * ```typescript
 * yield* setupToolSessions({
 *   store: createInMemoryToolSessionStore(),
 *   samplingProvider: myProvider,
 * })
 *
 * // Now use* functions work anywhere in the scope
 * const registry = yield* useToolSessionRegistry()
 * const session = yield* registry.create(myTool, params)
 * ```
 *
 * @packageDocumentation
 */
import { createContext, type Context, type Operation } from 'effection'
import type {
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSessionSamplingProvider,
} from './types.ts'

// =============================================================================
// CONTEXTS
// =============================================================================

/**
 * Context for the tool session store.
 */
export const ToolSessionStoreContext: Context<ToolSessionStore | undefined> =
  createContext<ToolSessionStore | undefined>('mcp-tools:sessionStore', undefined)

/**
 * Context for the tool session registry.
 */
export const ToolSessionRegistryContext: Context<ToolSessionRegistry | undefined> =
  createContext<ToolSessionRegistry | undefined>('mcp-tools:sessionRegistry', undefined)

/**
 * Context for the sampling provider.
 */
export const ToolSessionSamplingProviderContext: Context<ToolSessionSamplingProvider | undefined> =
  createContext<ToolSessionSamplingProvider | undefined>(
    'mcp-tools:samplingProvider',
    undefined
  )

// =============================================================================
// ACCESSORS
// =============================================================================

/**
 * Get the tool session store from context.
 * Throws if not configured.
 */
export function* useToolSessionStore(): Operation<ToolSessionStore> {
  const store = yield* ToolSessionStoreContext.get()
  if (!store) {
    throw new Error(
      'ToolSessionStore not configured. ' +
        'Call setupToolSessions() or set ToolSessionStoreContext before use.'
    )
  }
  return store
}

/**
 * Get the tool session registry from context.
 * Throws if not configured.
 */
export function* useToolSessionRegistry(): Operation<ToolSessionRegistry> {
  const registry = yield* ToolSessionRegistryContext.get()
  if (!registry) {
    throw new Error(
      'ToolSessionRegistry not configured. ' +
        'Call setupToolSessions() or set ToolSessionRegistryContext before use.'
    )
  }
  return registry
}

/**
 * Get the sampling provider from context.
 * Throws if not configured.
 */
export function* useToolSessionSamplingProvider(): Operation<ToolSessionSamplingProvider> {
  const provider = yield* ToolSessionSamplingProviderContext.get()
  if (!provider) {
    throw new Error(
      'ToolSessionSamplingProvider not configured. ' +
        'Call setupToolSessions() or set ToolSessionSamplingProviderContext before use.'
    )
  }
  return provider
}

// =============================================================================
// OPTIONAL ACCESSORS
// =============================================================================

/**
 * Get the tool session store from context, or undefined if not set.
 */
export function* useOptionalToolSessionStore(): Operation<ToolSessionStore | undefined> {
  return yield* ToolSessionStoreContext.get()
}

/**
 * Get the tool session registry from context, or undefined if not set.
 */
export function* useOptionalToolSessionRegistry(): Operation<ToolSessionRegistry | undefined> {
  return yield* ToolSessionRegistryContext.get()
}

/**
 * Get the sampling provider from context, or undefined if not set.
 */
export function* useOptionalToolSessionSamplingProvider(): Operation<ToolSessionSamplingProvider | undefined> {
  return yield* ToolSessionSamplingProviderContext.get()
}
