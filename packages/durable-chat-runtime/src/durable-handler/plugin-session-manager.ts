/**
 * Plugin Session Manager
 *
 * Manages plugin tool sessions for the chat-engine. This enables MCP plugin tools
 * to suspend mid-execution (e.g., for elicitation) and resume across HTTP request
 * boundaries.
 *
 * Sampling is handled server-side using the chat engine's provider. Sessions
 * are keyed by the model's stable tool-call ID and advance through the
 * installed invocation host. Event observation remains pull-only.
 *
 * @packageDocumentation
 */
import { type Operation, type Channel, resource } from "effection";
import type { Json } from "@sweatpants/foundation";
import {
  ToolInvocationEventSourcePort,
  ToolInvocationHostPort,
  type ToolInvocationEventReader,
  type ToolSessionStatus,
  type ToolSessionSamplingProvider,
} from "@sweatpants/tool-session";
import type {
  ElicitsMap,
  ToolDefinition,
  ElicitExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
interface ComponentEmissionPayload {
  readonly componentKey: string;
  readonly props: Record<string, unknown>;
  readonly _component?: unknown;
}
interface PendingEmission<TPayload = unknown, TResponse = unknown> {
  readonly emission: { readonly payload: TPayload };
  readonly respond: (value: TResponse) => void;
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Status of a plugin session.
 */
export type PluginSessionStatus = ToolSessionStatus | "aborted";

/**
 * Information about an active plugin session (for inspection).
 */
export interface PluginSessionInfo {
  id: string;
  toolName: string;
  callId: string;
  status: PluginSessionStatus;
  createdAt: number;
}

/**
 * Events emitted by a plugin session.
 * These are a subset of ToolSessionEvent, filtered for the chat-engine's needs.
 */
export type PluginSessionEvent =
  | {
      type: "elicit_request";
      elicitId: string;
      key: string;
      message: string;
      schema: Record<string, unknown>;
      context?: Json;
    }
  | {
      type: "result";
      result: unknown;
    }
  | {
      type: "error";
      name: string;
      message: string;
    }
  | {
      type: "cancelled";
      reason?: string | undefined;
    };

/**
 * Configuration for creating a plugin session.
 */
export interface CreatePluginSessionConfig {
  /** The MCP tool to execute */
  tool: ToolDefinition<string, unknown, unknown, ElicitsMap>;

  /** Tool parameters */
  params: Json;

  /** Call ID from the LLM's tool_call (used as session ID) */
  callId: string;

  /** Emission channel for plugin UI rendering (optional) */
  emissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * A plugin session handle.
 *
 * Wraps a ToolSession with chat-engine-specific functionality:
 * - Server-side sampling handling
 * - Simplified event interface
 */
export interface PluginSession {
  /** Session ID (same as callId) */
  readonly id: string;

  /** Tool name */
  readonly toolName: string;

  /** Original call ID from LLM */
  readonly callId: string;

  /** Get current session status */
  status(): Operation<PluginSessionStatus>;

  /**
   * Get the next event from the session.
   * Blocks until an event is available or session completes.
   * Handles sample_request events internally (server-side sampling).
   */
  nextEvent(): Operation<PluginSessionEvent | null>;

  /**
   * Respond to an elicitation request.
   *
   * @param elicitId - The elicit ID from the elicit_request event
   * @param result - The user's response
   */
  respondToElicit(elicitId: string, result: ElicitExchangeCompletion<Json>): Operation<void>;

  /**
   * Abort the session.
   *
   * @param reason - Optional abort reason
   */
  abort(reason?: string): Operation<void>;
}

/**
 * Plugin Session Manager interface.
 */
export interface PluginSessionManager {
  /**
   * Create a new plugin session for a tool execution.
   *
   * @param config - Session configuration
   * @returns The created session
   */
  create(config: CreatePluginSessionConfig): Operation<PluginSession>;

  /**
   * Get an existing session by ID (callId).
   * Returns null if session doesn't exist.
   *
   * @param sessionId - Session to retrieve
   */
  get(sessionId: string): Operation<PluginSession | null>;

  /**
   * Abort a session by ID.
   *
   * @param sessionId - Session to abort
   * @param reason - Optional abort reason
   */
  abort(sessionId: string, reason?: string): Operation<void>;

  /**
   * List all active sessions (for debugging/inspection).
   */
  listActive(): Operation<PluginSessionInfo[]>;
}

/**
 * Options for creating a PluginSessionManager.
 */
export interface PluginSessionManagerOptions {
  /** Provider used for server-side sampling when a plugin tool calls ctx.sample(). */
  samplingProvider?: ToolSessionSamplingProvider;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a PluginSessionManager.
 *
 * The manager projects plugin-oriented sessions over the installed host:
 * - Per-session provider management for server-side sampling
 * - A simplified event interface that handles sample requests internally
 * - Session recovery by stable invocation identity
 */
export function createPluginSessionManager(
  options: PluginSessionManagerOptions,
): Operation<PluginSessionManager> {
  return resource<PluginSessionManager>(function* (provide) {
    const { samplingProvider } = options;
    const host = yield* ToolInvocationHostPort.use();
    const events = yield* ToolInvocationEventSourcePort.use();

    const pluginSessions = new Map<
      string,
      {
        session: PluginSession;
        info: PluginSessionInfo;
      }
    >();

    function createPluginSessionWrapper(
      invocationId: string,
      toolName: string,
      projection: ToolInvocationEventReader,
      callId: string,
      initialLastLSN = 0,
      onTerminal?: () => void,
    ): PluginSession {
      let aborted = false;
      let abortReason: string | undefined;
      let status: PluginSessionStatus = "running";
      let lastProcessedLSN = initialLastLSN;

      const pluginSession: PluginSession = {
        id: invocationId,
        toolName,
        callId,

        *status(): Operation<PluginSessionStatus> {
          return status;
        },

        *nextEvent(): Operation<PluginSessionEvent | null> {
          if (aborted) {
            return { type: "cancelled", reason: abortReason };
          }

          const eventSubscription = yield* projection.events(lastProcessedLSN);
          while (true) {
            const result = yield* eventSubscription.next();
            if (result.done) return null;

            const event = result.value;
            lastProcessedLSN = event.lsn;

            switch (event.type) {
              case "elicit_request":
                status = "awaiting_elicit";
                return {
                  type: "elicit_request",
                  elicitId: event.elicitId,
                  key: event.key,
                  message: event.message,
                  schema: event.schema,
                  ...(event.context ? { context: event.context } : {}),
                };

              case "sample_request": {
                const sampleResult:
                  | SampleExchangeCompletionBase
                  | ParsedSampleExchangeCompletion<unknown>
                  | ToolCallSampleExchangeCompletion = samplingProvider
                  ? yield* samplingProvider.sample(event.messages, {
                      ...(event.systemPrompt ? { systemPrompt: event.systemPrompt } : {}),
                      ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
                      ...(event.tools ? { tools: event.tools } : {}),
                      ...(event.toolChoice ? { toolChoice: event.toolChoice } : {}),
                      ...(event.schema ? { schema: event.schema } : {}),
                    })
                  : { text: "[Sampling error: Plugin sampling provider not configured]" };
                status = "running";
                yield* host.turn({
                  invocationId,
                  commandId: `plugin-sample:${event.sampleId}`,
                  cursor: event.lsn,
                  resume: { kind: "sample", requestId: event.sampleId, response: sampleResult },
                });
                continue;
              }

              case "result":
                status = "completed";
                onTerminal?.();
                return { type: "result", result: event.result };
              case "error":
                status = "failed";
                onTerminal?.();
                return { type: "error", name: event.name, message: event.message };
              case "cancelled":
                status = "cancelled";
                onTerminal?.();
                return { type: "cancelled", reason: event.reason };
              case "progress":
              case "log":
              case "sample_response_queued":
                continue;
            }
          }
        },

        *respondToElicit(elicitId, result): Operation<void> {
          status = "running";
          yield* host.turn({
            invocationId,
            commandId: `plugin-elicit:${elicitId}`,
            cursor: lastProcessedLSN,
            resume: { kind: "elicit", requestId: elicitId, response: result },
          });
        },

        *abort(reason?: string): Operation<void> {
          aborted = true;
          abortReason = reason;
          status = "aborted";
          yield* host.turn({
            invocationId,
            commandId: `plugin-cancel:${invocationId}`,
            cursor: lastProcessedLSN,
            resume: { kind: "cancel", ...(reason === undefined ? {} : { reason }) },
          });
          yield* host.dispose(invocationId);
        },
      };

      return pluginSession;
    }

    const manager: PluginSessionManager = {
      *create(config): Operation<PluginSession> {
        const { tool, params, callId } = config;
        yield* host.start({ invocationId: callId, tool, input: params });
        yield* host.turn({
          invocationId: callId,
          commandId: `plugin-start:${callId}`,
          cursor: 0,
        });
        const projection = yield* events.open(callId);
        if (!projection) throw new Error(`Plugin invocation ${callId} was not published`);

        const createdAt = Date.now();
        const pluginSession = createPluginSessionWrapper(
          callId,
          tool.name,
          projection,
          callId,
          0,
          () => pluginSessions.delete(callId),
        );
        const info: PluginSessionInfo = {
          id: callId,
          toolName: tool.name,
          callId,
          status: "running",
          createdAt,
        };
        pluginSessions.set(callId, { session: pluginSession, info });
        return pluginSession;
      },

      *get(sessionId): Operation<PluginSession | null> {
        return pluginSessions.get(sessionId)?.session ?? null;
      },

      *abort(sessionId, reason?: string): Operation<void> {
        const entry = pluginSessions.get(sessionId);
        if (!entry) return;
        yield* entry.session.abort(reason);
        pluginSessions.delete(sessionId);
      },

      *listActive(): Operation<PluginSessionInfo[]> {
        const infos: PluginSessionInfo[] = [];
        for (const entry of pluginSessions.values()) {
          entry.info.status = yield* entry.session.status();
          infos.push({ ...entry.info });
        }
        return infos;
      },
    };

    yield* provide(manager);
  });
}
