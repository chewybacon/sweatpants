/**
 * MCP Tool Session Module
 *
 * Provides durable tool execution sessions that keep generators alive
 * across HTTP requests, supporting MCP's elicitation and sampling backchannels.
 *
 * ## Quick Start
 *
 * ```typescript
 * import {
 *   setupToolSessions,
 *   createInMemoryToolSessionStore,
 *   useToolSessionRegistry,
 * } from '@grove/framework/mcp-tools/session'
 *
 * // At app startup
 * yield* setupToolSessions({
 *   store: yield* createInMemoryToolSessionStore(),
 *   samplingProvider: mySamplingProvider,
 * })
 *
 * // Create a session for a tool
 * const registry = yield* useToolSessionRegistry()
 * const session = yield* registry.create(myTool, params)
 *
 * // Stream events via SSE
 * for (const event of yield* each(session.events())) {
 *   // Handle elicit_request, sample_request, progress, log, result, error
 *   if (event.type === 'elicit_request') {
 *     // Render UI, get user response, then:
 *     yield* session.respondToElicit(event.elicitId, userResponse)
 *   }
 *   yield* each.next()
 * }
 * ```
 *
 * ## Resumability
 *
 * Sessions support reconnection via LSN (Logical Sequence Number):
 *
 * ```typescript
 * // Client reconnects with last seen LSN
 * const session = yield* registry.acquire(sessionId)
 * for (const event of yield* each(session.events(lastLSN))) {
 *   // Gets buffered events after lastLSN, then live events
 * }
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// TYPES
// =============================================================================

export type {
  // Session types
  ToolSession,
  ToolSessionStatus,
  ToolSessionOptions,
  ToolSessionEntry,
  
  // Event types
  ToolSessionEvent,
  ProgressEvent,
  LogEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
  
  // Registry and store
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSessionSamplingProvider,
  
  // Type helpers
  InferToolSessionResult,
  AnyToolSession,
} from './types'

// =============================================================================
// SESSION CREATION
// =============================================================================

export { createToolSession } from './tool-session'

// =============================================================================
// REGISTRY
// =============================================================================

export {
  createToolSessionRegistry,
  type ToolSessionRegistryOptions,
} from './session-registry'

// =============================================================================
// STORES
// =============================================================================

export {
  createInMemoryToolSessionStore,
  createInMemoryToolSessionStoreWithDebug,
} from './in-memory-store'

// =============================================================================
// CONTEXTS AND SETUP
// =============================================================================

export {
  // Setup function
  setupToolSessions,
  type SetupToolSessionsOptions,
  
  // Contexts
  ToolSessionStoreContext,
  ToolSessionRegistryContext,
  ToolSessionSamplingProviderContext,
  
  // Accessors (throw if not configured)
  useToolSessionStore,
  useToolSessionRegistry,
  useToolSessionSamplingProvider,
  
  // Optional accessors (return undefined if not configured)
  useOptionalToolSessionStore,
  useOptionalToolSessionRegistry,
  useOptionalToolSessionSamplingProvider,
} from './setup'
