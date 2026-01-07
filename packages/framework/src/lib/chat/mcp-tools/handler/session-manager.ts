/**
 * MCP Session Manager
 *
 * Manages MCP session state, correlating MCP-Session-Id headers with
 * underlying ToolSession instances.
 *
 * ## Responsibilities
 *
 * 1. Create new sessions for tools/call requests
 * 2. Track pending elicitation and sampling requests
 * 3. Route responses back to the correct tool session
 * 4. Manage session lifecycle with reference counting
 *
 * @packageDocumentation
 */
import { createContext, type Operation } from 'effection'
import type { ToolSessionRegistry } from '../session/types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'
import type { ElicitsMap, ElicitResult, SampleResult } from '../mcp-tool-types'
import type {
  McpSessionState,
  PendingElicitation,
  PendingSample,
  McpToolsCallRequest,
  McpElicitResponse,
  McpSampleResponse,
} from './types'
import { McpHandlerError, MCP_HANDLER_ERRORS } from './types'
import type { JsonRpcId } from '../protocol/types'

// =============================================================================
// SESSION MANAGER CONTEXT
// =============================================================================

/**
 * Context for accessing the session manager from within Operations.
 */
export const McpSessionManagerContext = createContext<McpSessionManager>('mcp-session-manager')

// =============================================================================
// SESSION MANAGER
// =============================================================================

/**
 * Options for creating a session manager.
 */
export interface McpSessionManagerOptions {
  /** Tool session registry */
  registry: ToolSessionRegistry

  /** Available tools by name */
  tools: Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>

  /** Session timeout in milliseconds */
  sessionTimeout?: number | undefined
}

/**
 * Manages MCP session state and lifecycle.
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, McpSessionState>()
  private readonly registry: ToolSessionRegistry
  private readonly tools: Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>>
  private readonly sessionTimeout: number

  constructor(options: McpSessionManagerOptions) {
    this.registry = options.registry
    this.tools = options.tools
    this.sessionTimeout = options.sessionTimeout ?? 300000 // 5 minutes
  }

  // ===========================================================================
  // SESSION LIFECYCLE
  // ===========================================================================

  /**
   * Create a new session for a tools/call request.
   */
  *createSession(request: McpToolsCallRequest): Operation<McpSessionState> {
    const { toolName, arguments: args, requestId } = request

    // Lookup tool
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.TOOL_NOT_FOUND,
        `Tool not found: ${toolName}`,
        404
      )
    }

    // Create tool session
    const session = yield* this.registry.create(tool, args, {
      timeout: this.sessionTimeout,
    })

    // Create session state
    const state: McpSessionState = {
      sessionId: session.id,
      session,
      toolCallRequestId: requestId,
      pendingElicits: new Map(),
      pendingSamples: new Map(),
      lastLSN: 0,
      requestCounter: 0,
    }

    this.sessions.set(session.id, state)
    return state
  }

  /**
   * Get an existing session by ID.
   */
  *getSession(sessionId: string): Operation<McpSessionState | null> {
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * Acquire an existing session (increments refcount in registry).
   */
  *acquireSession(sessionId: string): Operation<McpSessionState> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404
      )
    }

    // Acquire in registry
    yield* this.registry.acquire(sessionId)
    return state
  }

  /**
   * Release a session (decrements refcount in registry).
   */
  *releaseSession(sessionId: string): Operation<void> {
    yield* this.registry.release(sessionId)
  }

  /**
   * Terminate a session completely.
   */
  *terminateSession(sessionId: string): Operation<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return // Already terminated
    }

    // Cancel the tool execution
    yield* state.session.cancel('Session terminated by client')

    // Release from registry
    yield* this.registry.release(sessionId)

    // Remove from local state
    this.sessions.delete(sessionId)
  }

  // ===========================================================================
  // PENDING REQUEST TRACKING
  // ===========================================================================

  /**
   * Register a pending elicitation request.
   */
  registerPendingElicit(
    sessionId: string,
    elicitId: string,
    requestId: JsonRpcId,
    key: string
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.pendingElicits.set(String(requestId), {
      elicitId,
      requestId,
      key,
    })
  }

  /**
   * Register a pending sampling request.
   */
  registerPendingSample(
    sessionId: string,
    sampleId: string,
    requestId: JsonRpcId
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.pendingSamples.set(String(requestId), {
      sampleId,
      requestId,
    })
  }

  /**
   * Get a pending elicitation by request ID.
   */
  getPendingElicit(sessionId: string, requestId: JsonRpcId): PendingElicitation | null {
    const state = this.sessions.get(sessionId)
    if (!state) return null

    return state.pendingElicits.get(String(requestId)) ?? null
  }

  /**
   * Get a pending sample by request ID.
   */
  getPendingSample(sessionId: string, requestId: JsonRpcId): PendingSample | null {
    const state = this.sessions.get(sessionId)
    if (!state) return null

    return state.pendingSamples.get(String(requestId)) ?? null
  }

  /**
   * Clear a pending elicitation.
   */
  clearPendingElicit(sessionId: string, requestId: JsonRpcId): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.pendingElicits.delete(String(requestId))
  }

  /**
   * Clear a pending sample.
   */
  clearPendingSample(sessionId: string, requestId: JsonRpcId): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.pendingSamples.delete(String(requestId))
  }

  // ===========================================================================
  // RESPONSE HANDLING
  // ===========================================================================

  /**
   * Handle an elicitation response from the client.
   */
  *handleElicitResponse(response: McpElicitResponse): Operation<void> {
    const { sessionId, requestId, action, content } = response

    // Find pending elicitation
    const pending = this.getPendingElicit(sessionId, requestId)
    if (!pending) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.REQUEST_NOT_FOUND,
        `No pending elicitation for request ${requestId}`,
        400
      )
    }

    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404
      )
    }

    // Build elicit result
    let elicitResult: ElicitResult<unknown>
    switch (action) {
      case 'accept':
        elicitResult = { action: 'accept', content: content ?? {} }
        break
      case 'decline':
        elicitResult = { action: 'decline' }
        break
      case 'cancel':
        elicitResult = { action: 'cancel' }
        break
    }

    // Send response to tool session
    yield* state.session.respondToElicit(pending.elicitId, elicitResult)

    // Clear pending
    this.clearPendingElicit(sessionId, requestId)
  }

  /**
   * Handle a sampling response from the client.
   */
  *handleSampleResponse(response: McpSampleResponse): Operation<void> {
    const { sessionId, requestId, content, model, stopReason } = response

    // Find pending sample
    const pending = this.getPendingSample(sessionId, requestId)
    if (!pending) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.REQUEST_NOT_FOUND,
        `No pending sample request for request ${requestId}`,
        400
      )
    }

    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404
      )
    }

    // Extract text content from MCP content blocks
    let textContent: string
    if (typeof content === 'string') {
      textContent = content
    } else if (Array.isArray(content)) {
      // Array of content blocks
      textContent = content
        .filter((block): block is { type: 'text'; text: string } => 
          typeof block === 'object' && block !== null && block.type === 'text'
        )
        .map(block => block.text)
        .join('')
    } else if (typeof content === 'object' && content !== null) {
      // Single content block
      const block = content as { type?: string; text?: string }
      textContent = block.type === 'text' && typeof block.text === 'string' 
        ? block.text 
        : JSON.stringify(content)
    } else {
      textContent = String(content)
    }

    // Build sample result
    const sampleResult: SampleResult = {
      text: textContent,
      model,
    }
    if (stopReason !== undefined) {
      sampleResult.stopReason = stopReason
    }

    // Send response to tool session
    yield* state.session.respondToSample(pending.sampleId, sampleResult)

    // Clear pending
    this.clearPendingSample(sessionId, requestId)
  }

  // ===========================================================================
  // REQUEST ID GENERATION
  // ===========================================================================

  /**
   * Generate a new request ID for outgoing requests.
   */
  nextRequestId(sessionId: string): JsonRpcId {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return `req_${crypto.randomUUID()}`
    }

    state.requestCounter++
    return `req_${state.requestCounter}`
  }

  /**
   * Update the last LSN for a session.
   */
  updateLastLSN(sessionId: string, lsn: number): void {
    const state = this.sessions.get(sessionId)
    if (state) {
      state.lastLSN = lsn
    }
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /**
   * Cleanup all sessions.
   */
  *cleanup(): Operation<void> {
    for (const sessionId of this.sessions.keys()) {
      yield* this.terminateSession(sessionId)
    }
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a new session manager.
 */
export function createSessionManager(options: McpSessionManagerOptions): McpSessionManager {
  return new McpSessionManager(options)
}
