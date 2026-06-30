/**
 * Plugin Tool Executor for Chat Engine
 *
 * Handles execution of MCP plugin tools within the chat engine.
 * When a tool call matches a registered plugin, this module:
 * 1. Creates a BridgeHost to run the tool
 * 2. Handles elicit events by dispatching to plugin handlers
 * 3. Handles sample events using the chat provider
 * 4. Emits stream events for tool results/errors
 *
 * @packageDocumentation
 */
import { spawn, each, type Operation, type Channel } from "effection";
import type { ToolSessionSamplingProvider } from "../../lib/chat/mcp-tools/session/types.ts";
import type { PluginRegistry } from "../../lib/chat/mcp-tools/plugin-registry.ts";
import type { PluginClientRegistration } from "../../lib/chat/mcp-tools/plugin.ts";
import type { ElicitsMap } from "../../lib/chat/mcp-tools/mcp-tool-types.ts";
import type { McpRuntimeTool } from "../../lib/chat/mcp-tools/mcp-runtime-tool.ts";
import {
  createBridgeHost,
  type BridgeEvent,
  type ElicitResponse,
  type SampleResponse,
} from "../../lib/chat/mcp-tools/bridge-runtime.ts";
import {
  createPluginClientContext,
  executeElicitHandlerFromRequest,
} from "../../lib/chat/mcp-tools/plugin-executor.ts";
import type {
  ComponentEmissionPayload,
  PendingEmission,
} from "../../lib/chat/browser-rendering/emissions.ts";
import type { StreamEvent } from "../types.ts";
import type { ToolCall, ToolExecutionResult } from "./types.ts";
import {
  getToolParameterValidationErrorPayload,
  validateToolParameters,
  type ToolParameterValidationErrorPayload,
} from "../../lib/chat/tool-parameters.ts";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for plugin tool execution.
 */
export interface PluginToolExecutionConfig {
  /** The tool call from the LLM */
  toolCall: ToolCall;

  /** The finalized MCP tool (with .elicits) */
  tool: McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap>;

  /** The plugin client registration */
  plugin: PluginClientRegistration<ElicitsMap>;

  /** Provider for handling sample events */
  samplingProvider: ToolSessionSamplingProvider;

  /** Emission channel for plugin UI rendering */
  emissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined;

  /** Abort signal for cancellation */
  signal: AbortSignal;
}

/**
 * Result of plugin tool execution.
 */
export type PluginToolResult =
  | { ok: true; callId: string; toolName: string; result: unknown }
  | {
      ok: false;
      callId: string;
      toolName: string;
      error: string;
      code?: string;
      validation?: ToolParameterValidationErrorPayload;
    };

// =============================================================================
// PLUGIN TOOL DETECTION
// =============================================================================

/**
 * Check if a tool is a plugin tool (has .elicits property).
 */
export function isPluginTool(
  tool: unknown,
): tool is McpRuntimeTool<string, unknown, unknown, unknown, unknown, ElicitsMap> {
  return (
    tool != null &&
    typeof tool === "object" &&
    "elicits" in tool &&
    tool.elicits != null &&
    typeof tool.elicits === "object"
  );
}

/**
 * Get the plugin registration for a tool name, if it exists.
 */
export function getPluginForTool(
  toolName: string,
  pluginRegistry: PluginRegistry | undefined,
): PluginClientRegistration<ElicitsMap> | undefined {
  if (!pluginRegistry) return undefined;
  return pluginRegistry.get(toolName);
}

// =============================================================================
// PLUGIN TOOL EXECUTION
// =============================================================================

/**
 * Execute a plugin tool using the BridgeHost pattern.
 *
 * This function:
 * 1. Creates a BridgeHost for the tool
 * 2. Spawns an event handler to process bridge events
 * 3. Runs the tool to completion
 * 4. Returns the result
 */
export function* executePluginTool(config: PluginToolExecutionConfig): Operation<PluginToolResult> {
  const { toolCall, tool, plugin, samplingProvider, emissionChannel, signal } = config;
  const callId = toolCall.id;
  const toolName = toolCall.function.name;

  try {
    const params = validateToolParameters({
      schema: tool.parameters,
      params: toolCall.function.arguments,
      toolName,
      callId,
    });

    // Create the bridge host
    const host = createBridgeHost({
      tool,
      params,
      callId,
      signal,
    });

    // Spawn event handler to process bridge events
    yield* spawn(function* () {
      for (const event of yield* each(host.events)) {
        yield* handleBridgeEvent(event, plugin, samplingProvider, emissionChannel, callId, signal);
        yield* each.next();
      }
    });

    // Run the tool to completion
    const result = yield* host.run();

    return {
      ok: true,
      callId,
      toolName,
      result,
    };
  } catch (error) {
    const validation = getToolParameterValidationErrorPayload(error);
    return {
      ok: false,
      callId,
      toolName,
      error: validation?.message ?? (error instanceof Error ? error.message : String(error)),
      ...(validation ? { code: validation.code, validation } : {}),
    };
  }
}

/**
 * Handle a bridge event from the plugin tool.
 */
function* handleBridgeEvent(
  event: BridgeEvent,
  plugin: PluginClientRegistration<ElicitsMap>,
  samplingProvider: ToolSessionSamplingProvider,
  emissionChannel: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined,
  callId: string,
  signal: AbortSignal,
): Operation<void> {
  switch (event.type) {
    case "elicit": {
      // Create plugin client context
      if (!emissionChannel) {
        // No emission channel - can't render UI
        // Decline the elicitation
        event.responseSignal.send({
          id: event.request.id,
          result: { action: "decline" },
        });
        return;
      }

      const ctx = createPluginClientContext({
        callId,
        toolName: plugin.toolName,
        elicitRequest: event.request,
        emissionChannel,
        signal,
      });

      try {
        // Execute the plugin's handler for this elicitation key
        const result = yield* executeElicitHandlerFromRequest(plugin, event.request, ctx);

        // Send the response back to the tool
        event.responseSignal.send({
          id: event.request.id,
          result,
        } as ElicitResponse);
      } catch (error) {
        // Handler failed - cancel the elicitation
        event.responseSignal.send({
          id: event.request.id,
          result: { action: "cancel" },
        });
      }
      break;
    }

    case "sample": {
      try {
        const result = yield* samplingProvider.sample(event.messages, {
          ...(event.options?.systemPrompt ? { systemPrompt: event.options.systemPrompt } : {}),
          ...(event.options?.maxTokens !== undefined ? { maxTokens: event.options.maxTokens } : {}),
          ...(event.options?.tools ? { tools: event.options.tools } : {}),
          ...(event.options?.toolChoice ? { toolChoice: event.options.toolChoice } : {}),
          ...(event.options?.schema ? { schema: event.options.schema } : {}),
        });
        event.responseSignal.send({ result } as SampleResponse);
      } catch (error) {
        event.responseSignal.send({
          result: {
            text: `[Sampling error: ${error instanceof Error ? error.message : String(error)}]`,
          },
        } as SampleResponse);
      }
      break;
    }

    case "log": {
      // Logs are informational - could emit as stream events if needed
      // For now, just log to console in development
      if (process.env["NODE_ENV"] === "development") {
        console.log(`[Plugin ${plugin.toolName}] ${event.level}: ${event.message}`);
      }
      break;
    }

    case "notify": {
      // Progress notifications - could emit as stream events if needed
      // For now, just log to console in development
      if (process.env["NODE_ENV"] === "development") {
        const progress =
          event.progress !== undefined ? ` (${Math.round(event.progress * 100)}%)` : "";
        console.log(`[Plugin ${plugin.toolName}] Progress${progress}: ${event.message}`);
      }
      break;
    }
  }
}

/**
 * Convert a plugin tool result to a ToolExecutionResult.
 */
export function pluginResultToToolResult(result: PluginToolResult): ToolExecutionResult {
  if (result.ok) {
    return {
      ok: true,
      kind: "result",
      callId: result.callId,
      toolName: result.toolName,
      serverOutput: result.result,
    };
  }

  return {
    ok: false,
    error: {
      callId: result.callId,
      toolName: result.toolName,
      message: result.error,
      ...(result.code ? { code: result.code } : {}),
      ...(result.validation
        ? { issues: result.validation.issues, validation: result.validation }
        : {}),
    },
  };
}

/**
 * Convert a plugin tool result to an AG-UI StreamEvent.
 */
export function pluginResultToStreamEvent(result: PluginToolResult): StreamEvent {
  if (result.ok) {
    const content =
      typeof result.result === "string" ? result.result : JSON.stringify(result.result);

    return {
      type: "TOOL_CALL_RESULT",
      messageId: `tool:${result.callId}`,
      toolCallId: result.callId,
      toolCallName: result.toolName,
      content,
      role: "tool",
    };
  }

  return {
    type: "TOOL_CALL_RESULT",
    messageId: `tool:${result.callId}`,
    toolCallId: result.callId,
    toolCallName: result.toolName,
    content: `Error: ${result.error}`,
    role: "tool",
    ...(result.validation ? { error: result.validation } : {}),
  };
}
