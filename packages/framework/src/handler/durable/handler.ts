/**
 * Durable Chat Handler
 *
 * A pull-based chat handler that buffers all stream events for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * Protocol:
 * - Request params: sessionId (query/path), offset (query)
 * - Response: NDJSON with LSN in each event, X-Session-Id header
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { call, resource, type Operation, type Stream } from "effection";
import { z } from "zod";
import type {
  SessionHandle,
  SessionRegistry,
} from "../../lib/chat/durable-streams/index.ts";
import {
  useSessionRegistryStore,
  useSessionRegistry,
  useTokenBufferStore,
} from "../../lib/chat/durable-streams/index.ts";
import {
  MaxIterationsContext,
  McpToolRegistryContext,
  PersonaResolverContext,
  PluginRegistryContext,
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ProviderContext,
  ToolRegistryContext,
} from "../../lib/chat/providers/contexts.ts";
import { useLogger } from "../../lib/logger/index.ts";
import {
  bindModel,
  createBindingSource,
  stringParam,
} from "../model-binder.ts";
import { createStreamingHandler, useHandlerContext } from "../streaming.ts";
import type { StreamEvent } from "../types.ts";
import { createChatEngine } from "./chat-engine.ts";
import { buildAgUiCheckpoint, buildAgUiCustomState } from '../../lib/chat/session/ag-ui-checkpoint.ts';
import { createPluginSessionManager } from "./plugin-session-manager.ts";
import {
  recordConversationSession,
  resolveLatestConversationSession,
} from './conversation-index.ts';
import {
  createEmptyStream,
  createHeadMetadataResponse,
  createProtocolMutationResponse,
  createProtocolReadResponse,
  parseLiveMode,
  parseOffsetParam,
  parseSessionIdFromPath,
  parseTimeoutMs,
} from '@sweatpants/durable-streams';
import type {
  ChatRequestBody,
  DurableChatHandlerConfig,
  IsomorphicTool,
  ToolRegistry,
  ToolSchema,
} from "./types.ts";
import type { ConversationReplayState } from '../../lib/chat/session/streaming.ts'

// =============================================================================
// PROTOCOL PARAMETER BINDER
// =============================================================================

/**
 * Binder for durable stream protocol parameters.
 */
const durableParamsBinder = bindModel({
  sessionId: stringParam("x-unused-session-id", "sessionId"),
  conversationId: stringParam('x-conversation-id', 'conversationId'),
});


// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a tool registry from an array of tools.
 */
function createToolRegistry(tools: IsomorphicTool[]): ToolRegistry {
  const map = new Map<string, IsomorphicTool>();
  for (const tool of tools) {
    map.set(tool.name, tool);
  }
  return {
    get(name: string): IsomorphicTool | undefined {
      return map.get(name);
    },
    has(name: string): boolean {
      return map.has(name);
    },
    names(): string[] {
      return Array.from(map.keys());
    },
  };
}

/**
 * Convert a tool to its schema representation.
 */
function toToolSchema(tool: IsomorphicTool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
    isIsomorphic: true,
  };
}

/**
 * Check if an object is an MCP tool (has name, description, parameters).
 */
function isMcpToolLike(
  tool: unknown,
): tool is {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
} {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "name" in tool &&
    "description" in tool &&
    "parameters" in tool &&
    typeof (tool as { name: unknown }).name === "string" &&
    typeof (tool as { description: unknown }).description === "string"
  );
}

/**
 * Convert an MCP tool to its schema representation.
 */
function mcpToolToSchema(tool: {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
}): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
    isIsomorphic: false,
  };
}

/**
 * Create a serialized event stream from the chat engine.
 * Each event is JSON-serialized for storage in the buffer.
 */
function createSerializedEventStream(
  engine: Stream<StreamEvent, void>,
  initialEvents: StreamEvent[] = [],
): Stream<string, void> {
  return resource(function* (provide) {
    const subscription = yield* engine;
    let initialIndex = 0

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (initialIndex < initialEvents.length) {
          const event = initialEvents[initialIndex++]!
          return { done: false, value: JSON.stringify(event) }
        }

        const result = yield* subscription.next();
        if (result.done) {
          return { done: true, value: undefined };
        }
        return { done: false, value: JSON.stringify(result.value) };
      },
    });
  });
}

function mergeReplayState(
  base: ConversationReplayState | undefined,
  body: ChatRequestBody,
): ConversationReplayState | undefined {
  const traces = new Map<string, ConversationReplayState['toolTraces'][number]>()

  for (const trace of base?.toolTraces ?? []) {
    traces.set(trace.callId, trace)
  }

  for (const output of body.isomorphicClientOutputs ?? []) {
    if (!output.trace) {
      continue
    }

    traces.set(output.callId, {
      callId: output.callId,
      toolName: output.toolName,
      trace: output.trace,
    })
  }

  return traces.size > 0 ? { toolTraces: Array.from(traces.values()) } : undefined
}

// =============================================================================
// DURABLE CHAT HANDLER
// =============================================================================

/**
 * Create a durable chat handler.
 *
 * The handler:
 * 1. Binds protocol params from request (sessionId, offset)
 * 2. Runs initializer hooks to set up DI contexts
 * 3. Either reconnects to existing session or creates new one
 * 4. Streams events from buffer to response with LSN
 *
 * @param config - Handler configuration
 * @returns Fetch handler function
 */
export function createDurableChatHandler(config: DurableChatHandlerConfig) {
  const { initializerHooks, maxToolIterations = 10 } = config;

  return createStreamingHandler(
    function* () {
      const ctx = yield* useHandlerContext();
      const request = ctx.request;
      const bindingSource = createBindingSource(request);
      const pathSessionId = parseSessionIdFromPath(new URL(request.url).pathname);
      const {
        sessionId: requestedSessionId,
        conversationId: requestedConversationIdParam,
      } = durableParamsBinder(bindingSource);
      const parsedOffset = parseOffsetParam(
        bindingSource.searchParams.get("offset"),
      );
      const liveMode = parseLiveMode(bindingSource.searchParams.get("live"));
      const timeoutMs = parseTimeoutMs(bindingSource.searchParams.get("timeout"));
      const method = request.method.toUpperCase();
      const isProtocolMutation =
        pathSessionId !== undefined &&
        (method === 'PUT' || method === 'POST' || method === 'DELETE');

      // Parse request body for mutating requests only.
      const body = request.method === "POST" && !isProtocolMutation
        ? ((yield* call(() => request.json())) as ChatRequestBody)
        : ({ messages: [] } as ChatRequestBody);

      const requestedConversationId =
        body.conversationId?.trim() || requestedConversationIdParam?.trim() || undefined;

      // Run initializer hooks
      for (const hook of initializerHooks) {
        yield* hook({ request, body });
      }

      const bufferStore = yield* useTokenBufferStore<string>();
      const shouldResolveConversation =
        requestedConversationId !== undefined &&
        pathSessionId === undefined &&
        requestedSessionId === undefined &&
        method !== 'POST';
      const resolvedConversationSessionId = shouldResolveConversation
        ? yield* resolveLatestConversationSession(
            bufferStore,
            requestedConversationId,
          )
        : null;

      if (shouldResolveConversation && !resolvedConversationSessionId) {
        ctx.status = 404;
        return yield* createEmptyStream();
      }

      // Determine session ID
      const sessionId =
        pathSessionId ??
        requestedSessionId ??
        resolvedConversationSessionId ??
        crypto.randomUUID();
      const isReconnect =
        (
          pathSessionId !== undefined ||
          requestedSessionId !== undefined ||
          requestedConversationId !== undefined
        ) &&
        (parsedOffset.value !== null || parsedOffset.isNow);
      let startLSN = parsedOffset.value ?? 0;

      // Set response headers
      ctx.headers.set("X-Session-Id", sessionId);
      ctx.headers.set("Cache-Control", "no-store");

      // Get logger after hooks run (so setupLogger has executed)
      const log = yield* useLogger("handler:durable");
      log.debug(
        {
          sessionId,
          conversationId: requestedConversationId,
          resolvedConversationSessionId,
          method,
          isReconnect,
          startLSN,
          messageCount: body.messages.length,
        },
        "request received",
      );

      if (isProtocolMutation) {
        const registryStore = yield* useSessionRegistryStore();

        return yield* createProtocolMutationResponse({
          ctx,
          sessionId,
          method: method as 'PUT' | 'POST' | 'DELETE',
          bufferStore,
          registryStore,
          log,
        });
      }

      // Get dependencies from contexts
      const provider = yield* ProviderContext.get();
      if (!provider) {
        throw new Error(
          "Provider not configured. Ensure a provider initializer hook sets ProviderContext.",
        );
      }
      log.debug("provider configured");

      const tools = yield* ToolRegistryContext.get();
      if (!tools) {
        throw new Error(
          "Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.",
        );
      }
      log.debug({ toolCount: tools.length }, "tools configured");

      const resolvePersona = yield* PersonaResolverContext.get();
      const maxIterations =
        (yield* MaxIterationsContext.get()) ?? maxToolIterations;

      // Get optional plugin contexts for MCP plugin tools
      const pluginRegistry = yield* PluginRegistryContext.get();
      const mcpToolRegistry = yield* McpToolRegistryContext.get();
      if (pluginRegistry) {
        log.debug("plugin registry configured");
      }
      if (mcpToolRegistry) {
        log.debug("mcp tool registry configured");
      }

      // Get or create plugin session manager if we have plugin support
      // The manager must be created at server startup for multi-step elicitation to work
      let pluginSessionManager = undefined;
      if (pluginRegistry && mcpToolRegistry) {
        // Try to get shared manager from context first (preferred)
        const sharedManager = yield* PluginSessionManagerContext.get();

        if (sharedManager) {
          pluginSessionManager = sharedManager;
          log.debug("using shared plugin session manager from context");
        } else {
          // Fallback: try to create from shared registry (legacy path)
          const sharedRegistry = yield* PluginSessionRegistryContext.get();

          if (sharedRegistry) {
            pluginSessionManager = yield* createPluginSessionManager({
              registry: sharedRegistry,
            });
            log.warn(
              "PluginSessionManagerContext not set - creating per-request manager (multi-step elicitation may not work)",
            );
          } else {
            log.error(
              "Neither PluginSessionManagerContext nor PluginSessionRegistryContext set!",
            );
            log.error("Multi-step elicitation will not work.");
          }
        }
      }

      // Get session registry from durable streams context
      log.debug("getting session registry");
      const registry: SessionRegistry<string> =
        yield* useSessionRegistry<string>();
      log.debug("session registry acquired");

      // Create tool registry
      const toolRegistry = createToolRegistry(tools);

      // Build tool schemas
      const clientToolNames = (body.isomorphicTools ?? []).map((t) => t.name);
      const enabledToolNames = new Set<string>();
      let systemPrompt: string | undefined;
      let sessionInfo: (StreamEvent & { type: "session_info" }) | undefined;

      // Handle persona mode vs manual mode
      if (body.persona) {
        if (!resolvePersona) {
          throw new Error(
            "Persona mode not supported - no resolver configured",
          );
        }

        const resolved = resolvePersona(
          body.persona,
          body.personaConfig,
          body.enableOptionalTools,
          body.effort,
        );

        systemPrompt = resolved.systemPrompt;

        for (const toolName of resolved.tools) {
          if (toolRegistry.has(toolName)) {
            enabledToolNames.add(toolName);
          } else if (!clientToolNames.includes(toolName)) {
            throw new Error(`Unknown persona tool: ${toolName}`);
          }
        }

        sessionInfo = {
          type: "session_info",
          capabilities: {
            ...resolved.capabilities,
            tools: Array.from(
              new Set([
                ...resolved.capabilities.tools.filter(
                  (name) =>
                    toolRegistry.has(name) || clientToolNames.includes(name),
                ),
                ...clientToolNames,
              ]),
            ),
          },
          persona: resolved.name,
        };
      } else {
        // Manual mode
        for (const name of clientToolNames) {
          if (toolRegistry.has(name)) {
            enabledToolNames.add(name);
          }
        }

        if (body.enabledTools === true) {
          for (const name of toolRegistry.names()) {
            const tool = toolRegistry.get(name);
            if (tool && !tool.client) {
              enabledToolNames.add(name);
            }
          }
        } else if (Array.isArray(body.enabledTools)) {
          for (const name of body.enabledTools) {
            if (toolRegistry.has(name)) {
              enabledToolNames.add(name);
            }
          }
        }

        if (body.systemPrompt) {
          systemPrompt = body.systemPrompt;
        }

        sessionInfo = {
          type: "session_info",
          capabilities: {
            thinking: true,
            streaming: true,
            tools: Array.from(enabledToolNames),
          },
          persona: null,
        };
      }

      // Build tool schemas
      const serverEnabledSchemas = Array.from(enabledToolNames)
        .map((name) => toolRegistry.get(name))
        .filter((t): t is IsomorphicTool => t !== undefined)
        .map(toToolSchema);

      const clientSchemas = body.isomorphicTools ?? [];

      // Build MCP plugin tool schemas
      // Filter based on enabledPlugins:
      // - undefined or []: no plugin tools (explicit opt-in required)
      // - string[]: only include specified tools by name
      const mcpToolSchemas: ToolSchema[] = [];
      if (mcpToolRegistry) {
        const enabledPlugins = body.enabledPlugins ?? [];
        for (const toolName of enabledPlugins) {
          const tool = mcpToolRegistry.get(toolName);
          if (tool && isMcpToolLike(tool)) {
            mcpToolSchemas.push(mcpToolToSchema(tool));
          }
        }
      }

      // Dedupe schemas
      const seenNames = new Set<string>();
      const toolSchemas: ToolSchema[] = [];
      for (const schema of [
        ...serverEnabledSchemas,
        ...clientSchemas,
        ...mcpToolSchemas,
      ]) {
        if (!seenNames.has(schema.name)) {
          seenNames.add(schema.name);
          toolSchemas.push(schema);
        }
      }

      let session: SessionHandle<string>;

      // Debug: log which path we're taking and if we have elicit responses
      log.debug(
        {
          sessionId,
          isReconnect,
          hasElicitResponses: !!body.elicitResponses,
          elicitResponseCount: body.elicitResponses?.length ?? 0,
        },
        "determining path",
      );

      if (method === "HEAD") {
        log.debug({ sessionId }, "head request");
        return yield* createHeadMetadataResponse(ctx, registry, sessionId, startLSN);
      }

      if (isReconnect) {
        // RECONNECT PATH: Acquire existing session, stream from buffer at offset
        log.debug(
          { sessionId, startLSN },
          "reconnect path: acquiring existing session",
        );
        session = yield* registry.acquire(sessionId);
        log.debug({ sessionId }, "reconnect path: session acquired");
      } else {
        // NEW SESSION PATH: Create engine, stream to buffer, then to response
        log.debug({ sessionId }, "new session path: creating chat engine");

        // Create our own AbortController for the chat engine.
        // NOTE: We cannot use request.signal directly because some frameworks
        // (e.g., TanStack Start with h3) abort the signal after reading the body,
        // before the handler has returned a response. This causes the engine to
        // see an aborted signal and fail immediately.
        const engineAbortController = new AbortController();

        // Create the chat engine
        // toolSchemas includes server tools, client isomorphic tools, AND MCP plugin tools
        const engine = createChatEngine({
          messages: body.messages,
          ...(body.replayState ? { replayState: body.replayState } : {}),
          ...(systemPrompt !== undefined && { systemPrompt }),
          toolSchemas,
          toolRegistry,
          clientIsomorphicTools: clientSchemas,
          isomorphicClientOutputs: body.isomorphicClientOutputs ?? [],
          provider,
          maxIterations,
          signal: engineAbortController.signal,
          ...(body.model !== undefined && { model: body.model }),
          sessionInfo,
          agUiRun: {
            threadId: requestedConversationId ?? sessionId,
            runId: sessionId,
          },
          // Plugin support for MCP tools
          ...(pluginRegistry && { pluginRegistry }),
          ...(mcpToolRegistry && { mcpToolRegistry }),
          ...(pluginSessionManager && { pluginSessionManager }),
          // Pass elicit responses if provided
          ...(body.elicitResponses && {
            elicitResponses: body.elicitResponses,
          }),
          ...(body.pluginAbort && { pluginAbort: body.pluginAbort }),
        });
        log.debug({ sessionId }, "new session path: chat engine created");

        // Wrap engine to serialize events
        const initialReplayState = mergeReplayState(body.replayState, body)
        const initialEvents: StreamEvent[] = body.messages.length > 0
          ? [
              ...(requestedConversationId
                ? [{
                    type: 'ag_ui_run_started',
                    run: {
                      threadId: requestedConversationId,
                      runId: sessionId,
                    },
                    input: {
                      messages: body.messages,
                    },
                  } satisfies StreamEvent,
                  {
                    type: 'ag_ui_messages_snapshot',
                    run: {
                      threadId: requestedConversationId,
                      runId: sessionId,
                    },
                    messages: body.messages,
                  } satisfies StreamEvent,
                  {
                    type: 'ag_ui_state_snapshot',
                    run: {
                      threadId: requestedConversationId,
                      runId: sessionId,
                    },
                    state: buildAgUiCustomState({
                      ...(initialReplayState ? { replay: initialReplayState } : {}),
                    }),
                  } satisfies StreamEvent,
              {
                type: 'ag_ui_checkpoint',
                checkpoint: buildAgUiCheckpoint({
                  threadId: requestedConversationId,
                  runId: sessionId,
                  messages: body.messages,
                  assistantContent: '',
                  toolCalls: [],
                  serverToolResults: [],
                  ...(initialReplayState ? { replay: initialReplayState } : {}),
                }),
              } satisfies StreamEvent]
            : []),
          ]
        : []
        const serializedStream = createSerializedEventStream(engine, initialEvents);
        log.debug({ sessionId }, "new session path: serialized stream created");

        // Acquire session with the engine as source
        // The registry manages the writer task lifecycle internally via useBackgroundTask
        log.debug(
          { sessionId },
          "new session path: acquiring session with source",
        );
        session = yield* registry.acquire(sessionId, {
          source: serializedStream,
        });
        log.debug({ sessionId }, "new session path: session acquired");
      }

      if (requestedConversationId) {
        yield* recordConversationSession(
          bufferStore,
          requestedConversationId,
          sessionId,
        );
      }

      return yield* createProtocolReadResponse({
        ctx,
        registry,
        session,
        sessionId,
        startLSN,
        isReconnect,
        parsedOffset,
        liveMode,
        timeoutMs,
        log,
      });
    },
    {
      defaultHeaders: {
        "Content-Type": "application/x-ndjson",
      },
      serialize: (v) => v + "\n",
      onSetupError: (error, ctx) => {
        // Return NDJSON error event instead of plain JSON
        const errorEvent = {
          lsn: 0,
          event: {
            type: "error",
            message: error.message,
            recoverable: false,
          },
        };
        const body = JSON.stringify(errorEvent) + "\n";
        return new Response(body, {
          status: 200, // Stream "succeeded" but contains error event
          headers: ctx.headers,
        });
      },
    },
  );
}
