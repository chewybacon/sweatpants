/**
 * MCP Session Manager
 *
 * Manages MCP session state, correlating MCP-Session-Id headers with
 * invocation ids and pull-only notice readers.
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
import { createContext, type Operation } from "effection";
import { assertJson, parser, type Json } from "@sweatpants/foundation";
import { z } from "zod";
import type { ToolSessionRegistry } from "../../contract.ts";
import type { ToolInvocationHost } from "../../invocation.ts";
import type {
  ElicitsMap,
  ToolDefinition,
  ElicitExchangeCompletion,
  SampleExchangeCompletionBase,
} from "@sweatpants/agent-sdk";
import {
  MCP_HANDLER_ERRORS,
  McpHandlerError,
  type McpSessionState,
  type PendingElicitation,
  type PendingSample,
  type McpToolsCallRequest,
  type McpElicitResponse,
  type McpSampleResponse,
} from "./types.ts";
import type { JsonRpcId } from "../protocol/types.ts";

const textContentBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string().max(1024 * 1024),
});
const contentArrayParser = parser(z.array(z.unknown()).max(1_024));
const textContentBlockParser = parser(textContentBlockSchema);

function sampleTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const array = contentArrayParser.parse(content);
  if (array.ok) {
    return array.value
      .map((block) => textContentBlockParser.parse(block))
      .filter((result) => result.ok)
      .map((result) => result.value.text)
      .join("");
  }
  const block = textContentBlockParser.parse(content);
  return block.ok ? block.value.text : JSON.stringify(content);
}

// =============================================================================
// SESSION MANAGER CONTEXT
// =============================================================================

/**
 * Context for accessing the session manager from within Operations.
 */
export const McpSessionManagerContext = createContext<McpSessionManager>("mcp-session-manager");

// =============================================================================
// SESSION MANAGER
// =============================================================================

/**
 * Options for creating a session manager.
 */
export interface McpSessionManagerOptions {
  /** Registry used to locate the notice reader after host.start(). */
  registry: ToolSessionRegistry;

  /** Pull-based control plane for the live invocation. */
  host: ToolInvocationHost;

  /** Available tools by name */
  tools: Map<string, ToolDefinition<string, unknown, unknown, ElicitsMap>>;

  /** Retention hint passed by the runtime. */
  sessionTimeout?: number | undefined;
}

/**
 * Manages MCP session state and lifecycle.
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, McpSessionState>();
  private readonly registry: ToolSessionRegistry;
  private readonly host: ToolInvocationHost;
  private readonly tools: Map<string, ToolDefinition<string, unknown, unknown, ElicitsMap>>;

  constructor(options: McpSessionManagerOptions) {
    this.registry = options.registry;
    this.host = options.host;
    this.tools = options.tools;
  }

  // ===========================================================================
  // SESSION LIFECYCLE
  // ===========================================================================

  /**
   * Create a new session for a tools/call request.
   */
  *createSession(request: McpToolsCallRequest): Operation<McpSessionState> {
    const { toolName, arguments: args, requestId } = request;

    // Lookup tool
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.TOOL_NOT_FOUND,
        `Tool not found: ${toolName}`,
        404,
      );
    }

    const sessionId = request.sessionId ?? crypto.randomUUID();
    yield* this.host.start({
      invocationId: sessionId,
      tool,
      input: args,
    });
    const session = yield* this.registry.get(sessionId);
    if (!session) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Invocation ${sessionId} was not published`,
        500,
      );
    }
    // The first turn starts the tool and publishes its first ask or terminal.
    yield* this.host.turn({
      invocationId: sessionId,
      commandId: `mcp:${requestId}:start`,
      cursor: 0,
    });

    // Create session state
    const state: McpSessionState = {
      sessionId,
      notices: session.notices,
      toolCallRequestId: requestId,
      pendingElicits: new Map(),
      pendingSamples: new Map(),
      lastLSN: 0,
      requestCounter: 0,
    };

    this.sessions.set(session.id, state);
    return state;
  }

  /**
   * Get an existing session by ID.
   */
  *getSession(sessionId: string): Operation<McpSessionState | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Open an existing session for a pull-only notice reader. */
  *openSession(sessionId: string): Operation<McpSessionState> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404,
      );
    }

    return state;
  }

  /**
   * Terminate a session completely.
   */
  *terminateSession(sessionId: string): Operation<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return; // Already terminated
    }

    yield* this.host.turn({
      invocationId: sessionId,
      commandId: `mcp:${sessionId}:terminate`,
      cursor: state.lastLSN,
      resume: { kind: "cancel", reason: "Session terminated by client" },
    });
    yield* this.host.dispose(sessionId);

    // Remove from local state
    this.sessions.delete(sessionId);
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
    key: string,
    afterLSN: number,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.pendingElicits.set(String(requestId), {
      elicitId,
      requestId,
      key,
      afterLSN,
    });
  }

  /**
   * Register a pending sampling request.
   */
  registerPendingSample(
    sessionId: string,
    sampleId: string,
    requestId: JsonRpcId,
    afterLSN: number,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.pendingSamples.set(String(requestId), {
      sampleId,
      requestId,
      afterLSN,
    });
  }

  /**
   * Get a pending elicitation by request ID.
   */
  getPendingElicit(sessionId: string, requestId: JsonRpcId): PendingElicitation | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    return state.pendingElicits.get(String(requestId)) ?? null;
  }

  /**
   * Get a pending sample by request ID.
   */
  getPendingSample(sessionId: string, requestId: JsonRpcId): PendingSample | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    return state.pendingSamples.get(String(requestId)) ?? null;
  }

  /**
   * Clear a pending elicitation.
   */
  clearPendingElicit(sessionId: string, requestId: JsonRpcId): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.pendingElicits.delete(String(requestId));
  }

  /**
   * Clear a pending sample.
   */
  clearPendingSample(sessionId: string, requestId: JsonRpcId): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.pendingSamples.delete(String(requestId));
  }

  // ===========================================================================
  // RESPONSE HANDLING
  // ===========================================================================

  /**
   * Handle an elicitation response from the client.
   */
  *handleElicitResponse(response: McpElicitResponse): Operation<void> {
    const { sessionId, requestId, action, content } = response;

    // Find pending elicitation
    const pending = this.getPendingElicit(sessionId, requestId);
    if (!pending) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.REQUEST_NOT_FOUND,
        `No pending elicitation for request ${requestId}`,
        400,
      );
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404,
      );
    }

    // Build the wire result. This pass-through layer does not own the
    // originating elicit context, so exchange construction happens where the
    // elicit originated (bridge/worker runtime), not here.
    let elicitResult: ElicitExchangeCompletion<Json>;
    switch (action) {
      case "accept":
        elicitResult = {
          action: "accept",
          content: assertJson(content ?? {}),
        };
        break;
      case "decline":
        elicitResult = { action: "decline" };
        break;
      case "cancel":
        elicitResult = { action: "cancel" };
        break;
    }

    yield* this.host.turn({
      invocationId: sessionId,
      commandId: `mcp:${String(requestId)}`,
      cursor: pending.afterLSN,
      resume: {
        kind: "elicit",
        requestId: pending.elicitId,
        response: elicitResult,
      },
    });

    // Clear pending
    this.clearPendingElicit(sessionId, requestId);
  }

  /**
   * Handle a sampling response from the client.
   */
  *handleSampleResponse(response: McpSampleResponse): Operation<void> {
    const { sessionId, requestId, content, model, stopReason } = response;

    // Find pending sample
    const pending = this.getPendingSample(sessionId, requestId);
    if (!pending) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.REQUEST_NOT_FOUND,
        `No pending sample request for request ${requestId}`,
        400,
      );
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
        404,
      );
    }

    // Parse the provider content compatibility union once before projection.
    const textContent = sampleTextFromContent(content);

    const sampleResult: SampleExchangeCompletionBase = {
      text: textContent,
      model,
      ...(stopReason !== undefined ? { stopReason } : {}),
    };

    // Clear pending tracking first
    this.clearPendingSample(sessionId, requestId);

    yield* this.host.turn({
      invocationId: sessionId,
      commandId: `mcp:${String(requestId)}`,
      cursor: pending.afterLSN,
      resume: {
        kind: "sample",
        requestId: pending.sampleId,
        response: sampleResult,
      },
    });
  }

  // ===========================================================================
  // REQUEST ID GENERATION
  // ===========================================================================

  /**
   * Generate a new request ID for outgoing requests.
   */
  nextRequestId(sessionId: string): JsonRpcId {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return `req_${crypto.randomUUID()}`;
    }

    state.requestCounter++;
    return `req_${state.requestCounter}`;
  }

  /**
   * Update the last LSN for a session.
   */
  updateLastLSN(sessionId: string, lsn: number): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.lastLSN = lsn;
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
      yield* this.terminateSession(sessionId);
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
  return new McpSessionManager(options);
}
