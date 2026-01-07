/**
 * MCP Tool Session Setup
 *
 * Configures all contexts for tool session management.
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type {
  ToolSessionStore,
  ToolSessionSamplingProvider,
  ToolSessionRegistry,
} from './types'
import {
  ToolSessionStoreContext,
  ToolSessionRegistryContext,
  ToolSessionSamplingProviderContext,
} from './contexts'
import {
  createToolSessionRegistry,
  type ToolSessionRegistryOptions,
} from './session-registry'

// =============================================================================
// SETUP OPTIONS
// =============================================================================

/**
 * Options for setting up tool sessions.
 */
export interface SetupToolSessionsOptions {
  /**
   * Store for tool session entries.
   * Use createInMemoryToolSessionStore() for single-process deployments,
   * or implement ToolSessionStore for distributed deployments.
   */
  store: ToolSessionStore

  /**
   * Provider for LLM sampling when tools use ctx.sample().
   */
  samplingProvider: ToolSessionSamplingProvider

  /**
   * Default timeout for sessions in milliseconds.
   * @default undefined (no timeout)
   */
  defaultTimeout?: number
}

// =============================================================================
// SETUP FUNCTION
// =============================================================================

/**
 * Setup tool session contexts.
 *
 * Call this at app startup to configure tool session management.
 * After calling, you can use:
 * - `useToolSessionRegistry()` to create and manage sessions
 * - `useToolSessionStore()` for direct store access
 * - `useToolSessionSamplingProvider()` for the sampling provider
 *
 * @param options - Configuration options
 * @returns The created registry
 *
 * @example
 * ```typescript
 * import { main } from 'effection'
 * import {
 *   setupToolSessions,
 *   createInMemoryToolSessionStore,
 *   useToolSessionRegistry,
 * } from '@grove/framework/mcp-tools'
 *
 * await main(function* () {
 *   // Setup at app startup
 *   const registry = yield* setupToolSessions({
 *     store: yield* createInMemoryToolSessionStore(),
 *     samplingProvider: {
 *       *sample(messages, options) {
 *         // Call your LLM here
 *         return { content: 'response' }
 *       },
 *     },
 *   })
 *
 *   // Later, anywhere in the app...
 *   const session = yield* registry.create(myTool, params)
 *   // OR
 *   const reg = yield* useToolSessionRegistry()
 *   const session = yield* reg.create(myTool, params)
 * })
 * ```
 */
export function* setupToolSessions(
  options: SetupToolSessionsOptions
): Operation<ToolSessionRegistry> {
  const { store, samplingProvider, defaultTimeout } = options

  // Set store context
  yield* ToolSessionStoreContext.set(store)

  // Set sampling provider context
  yield* ToolSessionSamplingProviderContext.set(samplingProvider)

  // Create registry
  const registryOptions: ToolSessionRegistryOptions = {
    samplingProvider,
    ...(defaultTimeout !== undefined && { defaultTimeout }),
  }
  const registry = yield* createToolSessionRegistry(store, registryOptions)

  // Set registry context
  yield* ToolSessionRegistryContext.set(registry)

  return registry
}

// =============================================================================
// CONVENIENCE RE-EXPORTS
// =============================================================================

export {
  ToolSessionStoreContext,
  ToolSessionRegistryContext,
  ToolSessionSamplingProviderContext,
  useToolSessionStore,
  useToolSessionRegistry,
  useToolSessionSamplingProvider,
  useOptionalToolSessionStore,
  useOptionalToolSessionRegistry,
  useOptionalToolSessionSamplingProvider,
} from './contexts'
