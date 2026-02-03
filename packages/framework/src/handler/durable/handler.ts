/**
 * Durable Chat Handler
 *
 * A pull-based chat handler that buffers all stream events for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * Protocol:
 * - Request params: X-Session-Id (header/query), X-Last-LSN (header/query)
 * - Response: NDJSON with LSN in each event, X-Session-Id header
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { call, resource, type Operation, type Stream } from "effection";
import { z } from "zod";
import type {
  SessionHandle,
  SessionRegistry,
  TokenBuffer,
} from "../../lib/chat/durable-streams/index.ts";
import {
  createPullStream,
  useSessionRegistry,
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
  type RegisterableTool,
} from "../../lib/chat/providers/contexts.ts";
import { isUnifiedTool, needsMcpRuntime, toMcpTool } from "../../lib/chat/tools/adapters/mcp.ts";
import type { AnyTool, FinalizedTool, ElicitsMap } from "../../lib/chat/tools/types.ts";
import type { FinalizedMcpToolWithElicits } from "../../lib/chat/mcp-tools/mcp-tool-builder.ts";
import type { ElicitsMap as McpElicitsMap } from "../../lib/chat/mcp-tools/mcp-tool-types.ts";
import { useLogger } from "../../lib/logger/index.ts";
import {
  bindModel,
  createBindingSource,
  intParam,
  stringParam,
} from "../model-binder.ts";
import { createStreamingHandler, useHandlerContext } from "../streaming.ts";
import type { StreamEvent } from "../types.ts";
import { createChatEngine } from "./chat-engine.ts";
import { createPluginSessionManager } from "./plugin-session-manager.ts";
import type {
  ChatRequestBody,
  DurableChatHandlerConfig,
  IsomorphicTool,
  ToolRegistry,
  ToolSchema,
} from "./types.ts";

// =============================================================================
// PROTOCOL PARAMETER BINDER
// =============================================================================

/**
 * Binder for durable stream protocol parameters.
 */
const durableParamsBinder = bindModel({
  sessionId: stringParam("x-session-id", "sessionId"),
  lastLSN: intParam("x-last-lsn", "lastLsn"),
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize a tool to IsomorphicTool format.
 * Unified tools are converted to isomorphic format for runtime compatibility.
 *
 * Note: Unified tools with elicits or handoff mode are routed to the MCP runtime
 * and not executed through the isomorphic path.
 */
function normalizeToIsomorphicTool(tool: RegisterableTool): IsomorphicTool {
  if (isUnifiedTool(tool)) {
    const unifiedTool = tool as AnyTool;
    
    // Check if this tool needs MCP runtime (has elicits or is handoff mode)
    if (needsMcpRuntime(unifiedTool)) {
      // Tools that need MCP runtime are routed there, not through isomorphic path.
      // Create a stub isomorphic tool that will be skipped in executeToolCall.
      // The actual execution happens via the MCP tool registry.
      return {
        name: unifiedTool.name,
        description: unifiedTool.description,
        parameters: unifiedTool.parameters,
        authority: 'server',
        // No server function - execution handled by MCP runtime
      };
    }
    
    // Simple execute-only tool - convert to isomorphic format
    if (unifiedTool.mode === 'execute' && unifiedTool.execute) {
      return {
        name: unifiedTool.name,
        description: unifiedTool.description,
        parameters: unifiedTool.parameters,
        authority: 'server',
        server: unifiedTool.execute as any,
      };
    }
    
    throw new Error(`Unified tool "${unifiedTool.name}" has invalid mode: ${(unifiedTool as any).mode}`);
  }
  // Already in isomorphic format
  return tool as IsomorphicTool;
}

/**
 * Extract unified tools that need MCP runtime and convert them.
 * Returns a map of tool name to MCP tool format.
 */
function extractMcpUnifiedTools(tools: RegisterableTool[]): Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, McpElicitsMap>> {
  const mcpTools = new Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, McpElicitsMap>>();
  
  for (const tool of tools) {
    if (isUnifiedTool(tool)) {
      const unifiedTool = tool as FinalizedTool<string, any, any, any, any, ElicitsMap>;
      if (needsMcpRuntime(unifiedTool)) {
        const mcpTool = toMcpTool(unifiedTool);
        mcpTools.set(unifiedTool.name, mcpTool);
      }
    }
  }
  
  return mcpTools;
}

/**
 * Merge user-provided MCP tool registry with auto-extracted unified tools.
 */
function createMergedMcpToolRegistry(
  existingRegistry: { get(name: string): unknown | undefined; has(name: string): boolean; names(): string[] } | undefined,
  unifiedMcpTools: Map<string, FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, McpElicitsMap>>
): { get(name: string): unknown | undefined; has(name: string): boolean; names(): string[] } | undefined {
  // If no unified tools need MCP runtime and no existing registry, return undefined
  if (unifiedMcpTools.size === 0 && !existingRegistry) {
    return undefined;
  }
  
  // If no unified tools need MCP runtime, return existing registry as-is
  if (unifiedMcpTools.size === 0) {
    return existingRegistry;
  }
  
  // Merge both
  return {
    get(name: string): unknown | undefined {
      // Prefer existing registry (user-defined)
      const existing = existingRegistry?.get(name);
      if (existing !== undefined) return existing;
      return unifiedMcpTools.get(name);
    },
    has(name: string): boolean {
      return (existingRegistry?.has(name) ?? false) || unifiedMcpTools.has(name);
    },
    names(): string[] {
      const existingNames = existingRegistry?.names() ?? [];
      const unifiedNames = Array.from(unifiedMcpTools.keys());
      // Dedupe
      return Array.from(new Set([...existingNames, ...unifiedNames]));
    },
  };
}

/**
 * Create a tool registry from an array of tools.
 * Accepts both isomorphic tools and unified tools.
 */
function createToolRegistry(tools: RegisterableTool[]): ToolRegistry {
  const map = new Map<string, IsomorphicTool>();
  for (const tool of tools) {
    const isomorphicTool = normalizeToIsomorphicTool(tool);
    map.set(isomorphicTool.name, isomorphicTool);
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
    parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    isIsomorphic: true,
    authority: tool.authority ?? "server",
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
    parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    isIsomorphic: false,
    authority: "server",
  };
}

/**
 * Create a serialized event stream from the chat engine.
 * Each event is JSON-serialized for storage in the buffer.
 */
function createSerializedEventStream(
  engine: Stream<StreamEvent, void>,
): Stream<string, void> {
  return resource(function* (provide) {
    const subscription = yield* engine;

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const result = yield* subscription.next();
        if (result.done) {
          return { done: true, value: undefined };
        }
        return { done: false, value: JSON.stringify(result.value) };
      },
    });
  });
}

/**
 * Create a stream that transforms TokenFrame to durable event format.
 * Output: `{ lsn, event }` where event is the parsed JSON from the frame.
 *
 * If an error occurs during streaming, emits an error event and completes.
 */
function createDurableEventStream(
  buffer: TokenBuffer<string>,
  startLSN: number,
): Stream<string, void> {
  return resource(function* (provide) {
    const pullStream = yield* createPullStream(buffer, startLSN);
    let lastLSN = startLSN;
    let errorEmitted = false;

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (errorEmitted) {
          return { done: true, value: undefined };
        }

        try {
          const result = yield* pullStream.next();
          if (result.done) {
            return { done: true, value: undefined };
          }
          const frame = result.value;
          lastLSN = frame.lsn;
          const durableEvent = {
            lsn: frame.lsn,
            event: JSON.parse(frame.token),
          };
          return { done: false, value: JSON.stringify(durableEvent) };
        } catch (error) {
          // Convert error to error event
          errorEmitted = true;
          const errorEvent = {
            lsn: lastLSN + 1,
            event: {
              type: "error",
              message: error instanceof Error ? error.message : "Unknown error",
              recoverable: false,
            },
          };
          return { done: false, value: JSON.stringify(errorEvent) };
        }
      },
    });
  });
}

// =============================================================================
// DURABLE CHAT HANDLER
// =============================================================================

/**
 * Create a durable chat handler.
 *
 * The handler:
 * 1. Binds protocol params from request (sessionId, lastLSN)
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

      // Parse request body
      const body = (yield* call(() => request.json())) as ChatRequestBody;
      const bindingSource = createBindingSource(request);
      const { sessionId: requestedSessionId, lastLSN } =
        durableParamsBinder(bindingSource);

      // Determine session ID
      const sessionId = requestedSessionId ?? crypto.randomUUID();
      const isReconnect =
        requestedSessionId !== undefined && lastLSN !== undefined;
      const startLSN = lastLSN ?? 0;

      // Set response headers
      ctx.headers.set("X-Session-Id", sessionId);
      ctx.headers.set("Cache-Control", "no-cache");

      // Run initializer hooks
      for (const hook of initializerHooks) {
        yield* hook({ request, body });
      }

      // Get logger after hooks run (so setupLogger has executed)
      const log = yield* useLogger("handler:durable");
      log.debug(
        {
          sessionId,
          isReconnect,
          startLSN,
          messageCount: body.messages.length,
        },
        "request received",
      );

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
      const userMcpToolRegistry = yield* McpToolRegistryContext.get();
      
      // Extract unified tools that need MCP runtime and merge with user-provided registry
      const unifiedMcpTools = extractMcpUnifiedTools(tools);
      const mcpToolRegistry = createMergedMcpToolRegistry(userMcpToolRegistry, unifiedMcpTools);
      
      if (pluginRegistry) {
        log.debug("plugin registry configured");
      }
      if (mcpToolRegistry) {
        log.debug({ 
          userMcpTools: userMcpToolRegistry?.names().length ?? 0,
          unifiedMcpTools: unifiedMcpTools.size,
        }, "mcp tool registry configured");
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
        const serializedStream = createSerializedEventStream(engine);
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

      // Transform to durable event format and return with cleanup
      const effectiveStartLSN = isReconnect ? startLSN : 0;
      log.debug(
        { sessionId, effectiveStartLSN },
        "creating durable event stream",
      );
      const durableStream = createDurableEventStream(
        session.buffer,
        effectiveStartLSN,
      );
      const durableSubscription = yield* durableStream;
      log.debug({ sessionId }, "durable event subscription created");

      return {
        subscription: durableSubscription,
        cleanup: function* () {
          log.debug({ sessionId }, "releasing session");
          yield* registry.release(sessionId);
        },
      };
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
