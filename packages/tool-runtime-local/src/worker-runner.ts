/**
 * Worker Runner
 *
 * This module runs inside a worker thread and executes tool generators.
 * It uses @sweatpants/agent-sdk's worker transport for communication with the host.
 *
 * ## Lifecycle
 *
 * 1. Worker starts via @effectionx/worker's workerMain()
 * 2. Receives init data with tool name, params, sessionId
 * 3. Looks up tool in registry, creates MCP context
 * 4. Executes tool handler, sending sample/elicit requests to host
 * 5. Returns final result to host
 *
 * ## Architecture
 *
 * Uses @sweatpants/agent-sdk's worker transport:
 * - Worker sends requests via send.stream(request) (sample, elicit)
 * - Host sends a ready ACK, then processes requests and returns responses
 * - Progress/log are fire-and-forget (logged locally)
 *
 * @packageDocumentation
 */

import {
  runToolWorker as coreRunToolWorker,
  type WorkerToolContext as CoreWorkerToolContext,
  type WorkerInitData as CoreWorkerInitData,
  type WorkerMessage,
  type WorkerSampleResponse,
  type WorkerElicitResponse,
} from "@sweatpants/agent-sdk/transport/worker";
import {
  SampleValidationError,
  completeSampleExchange,
  type LogLevel,
  type SampleConfigSchemaMessages,
  type SampleConfigSchemaPrompt,
  type SampleConfigToolsMessages,
  type SampleConfigToolsPrompt,
  type SampleResultBase,
  type ParsedSampleExchangeCompletion,
  type SampleResultWithParsed,
  type SampleResultWithToolCalls,
  type SampleSchemaConfig,
  type SampleSchemaResult,
  type SampleToolsConfig,
  type SampleToolsResult,
  type SamplingToolDefinition,
  type ToolSampleConfig,
} from "@sweatpants/agent-sdk";
import type { JsonObject } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type { WorkerTool, WorkerToolRegistry, WorkerToolContext } from "./worker-types.js";
import {
  isMcpMessage,
  isToolCallMessage,
  isToolResultMessage,
  type ExtendedMessage,
} from "@sweatpants/tool-session/messages";
import { toToolParameterJsonSchema } from "@sweatpants/tool-session/tool-parameters";

// =============================================================================
// TYPE CONVERSION HELPERS
// =============================================================================

/**
 * Convert framework Message/ExtendedMessage to core WorkerMessage.
 *
 * Handles all ExtendedMessage variants:
 * - Message (string content) → WorkerMessage with string content
 * - McpMessage (content blocks) → passthrough as WorkerMessage
 * - ToolCallMessage → WorkerMessage with tool_use content blocks
 * - ToolResultMessage → WorkerMessage with tool_result content block (role: 'user')
 */
function toWorkerMessage(msg: ExtendedMessage): WorkerMessage {
  // ToolCallMessage → assistant message with tool_use content blocks
  if (isToolCallMessage(msg)) {
    const contentBlocks: WorkerMessage["content"] = [];

    // Preserve any text content alongside the tool calls
    if (msg.content) {
      contentBlocks.push({ type: "text" as const, text: msg.content });
    }

    // Convert each tool call to a tool_use content block
    for (const call of msg.toolCalls) {
      contentBlocks.push({
        type: "tool_use" as const,
        id: call.id,
        name: call.function.name,
        input: call.function.arguments,
      });
    }

    return { role: "assistant", content: contentBlocks };
  }

  // ToolResultMessage → user message with tool_result content block
  // MCP convention: tool results are sent as role 'user' with tool_result content blocks
  if (isToolResultMessage(msg)) {
    return {
      role: "user",
      content: [
        {
          type: "tool_result" as const,
          toolUseId: msg.tool_call_id,
          content: [{ type: "text" as const, text: msg.content }],
          isError: msg.isError,
        },
      ],
    };
  }

  if (isMcpMessage(msg)) {
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    return {
      role: msg.role,
      content: blocks.map((block) => {
        switch (block.type) {
          case "text":
          case "tool_use":
            return block;
          case "tool_result":
            return {
              ...block,
              content: block.content.flatMap((content) =>
                content.type === "text" ? [content] : [],
              ),
            };
          default:
            throw new Error(`Worker sampling does not support MCP ${block.type} content`);
        }
      }),
    };
  }

  if (msg.role === "system") {
    throw new Error("Worker sample messages carry system text through systemPrompt");
  }
  return { role: msg.role, content: msg.content };
}

/** Converts a Standard Schema or explicit JSON Schema to bounded wire data. */
/**
 * Convert tool definition to core format.
 * Handles both Zod schemas and raw JSON schemas.
 * Zod schemas are converted to JSON Schema since they contain functions
 * that can't be cloned for postMessage to the host thread.
 */
function toWorkerToolDefinition(tool: SamplingToolDefinition): {
  name: string;
  description?: string;
  inputSchema: JsonObject;
} {
  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: toToolParameterJsonSchema(tool.inputSchema),
  };
}

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool session worker.
 *
 * This is the entry point for the worker thread. It uses @sweatpants/agent-sdk's
 * runToolWorker to handle the communication protocol, and wraps the core
 * context with MCP-specific functionality (exchanges, retry helpers).
 *
 * @param registry - Registry of available tools
 */
/** Narrow an array to the non-empty tuple type expected by guaranteed-result APIs. */
function isNonEmpty<T>(arr: T[] | undefined): arr is [T, ...T[]] {
  return Array.isArray(arr) && arr.length > 0;
}

export async function runWorker(registry: WorkerToolRegistry): Promise<void> {
  await coreRunToolWorker(function* (initData: CoreWorkerInitData, coreCtx: CoreWorkerToolContext) {
    const { toolName, params, sessionId } = initData;

    // Look up tool
    const tool = registry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // Create MCP tool context that wraps core context
    const ctx = createMcpWorkerContext(coreCtx, sessionId);

    // Execute the tool
    return yield* tool.handler(params, ctx) as Operation<unknown>;
  });
}

// =============================================================================
// MCP WORKER CONTEXT
// =============================================================================

/**
 * Create an MCP-flavored worker context from the core context.
 *
 * This wraps the core's simple sample/elicit with:
 * - Exchange construction for history accumulation
 * - Retry helpers (sampleTools, sampleSchema)
 * - Proper typing for MCP sample configs
 */
function createMcpWorkerContext(
  coreCtx: CoreWorkerToolContext,
  sessionId: string,
): WorkerToolContext {
  let toolCallIdCounter = 0;
  const generateToolCallId = () => `${sessionId}:tc:${++toolCallIdCounter}`;

  // Helper to extract prompt text for exchange construction
  function extractPromptText(config: ToolSampleConfig<ExtendedMessage>): string {
    if ("prompt" in config && config.prompt) {
      return config.prompt;
    }
    if ("messages" in config && config.messages) {
      const lastUserMsg = [...config.messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        return typeof lastUserMsg.content === "string" ? lastUserMsg.content : "[complex content]";
      }
    }
    return "";
  }

  // Helper to build messages for core sample
  function buildMessages(config: ToolSampleConfig<ExtendedMessage>): WorkerMessage[] {
    if ("prompt" in config && config.prompt) {
      return [{ role: "user", content: config.prompt }];
    }
    if ("messages" in config && config.messages) {
      return config.messages.map(toWorkerMessage);
    }
    return [];
  }

  // The unified sample implementation. `sampleTyped` overlays overload
  // signatures so schema/tools configs infer their result arm without casts.
  interface SampleTyped {
    <T>(
      config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T, ExtendedMessage>,
    ): Operation<SampleResultWithParsed<T>>;
    (
      config: SampleConfigToolsPrompt | SampleConfigToolsMessages<ExtendedMessage>,
    ): Operation<SampleResultWithToolCalls>;
    (
      config: ToolSampleConfig<ExtendedMessage>,
    ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
  }
  const sampleTyped = sampleImpl as SampleTyped;
  function* sampleImpl(
    config: ToolSampleConfig<ExtendedMessage>,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls> {
    const messages = buildMessages(config);
    const promptText = extractPromptText(config);

    // Build core sample options
    const coreOptions: Parameters<typeof coreCtx.sample>[0] = {
      messages,
      ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      ...(config.modelPreferences !== undefined && { modelPreferences: config.modelPreferences }),
    };

    // Handle schema (convert Zod to JSON schema marker)
    if ("schema" in config && config.schema) {
      coreOptions.schema = toToolParameterJsonSchema(config.schema);
    }

    // Handle tools
    if ("tools" in config && config.tools) {
      coreOptions.tools = config.tools.map(toWorkerToolDefinition);
      if (config.toolChoice !== undefined) {
        coreOptions.toolChoice = config.toolChoice;
      }
    }

    // Call core sample
    const response: WorkerSampleResponse = yield* coreCtx.sample(coreOptions);
    const completion = response.completion;

    if ("schema" in config && config.schema) {
      const schemaCompletion: ParsedSampleExchangeCompletion<unknown> =
        "parsed" in completion ? completion : { ...completion, parsed: null };
      return completeSampleExchange({
        promptText,
        completion: schemaCompletion,
        ...(schemaCompletion.parsed !== null ? { exchangeId: generateToolCallId() } : {}),
      });
    }

    return completeSampleExchange({ promptText, completion });
  }

  // The context object
  const ctx: WorkerToolContext = {
    signal: coreCtx.signal,
    log(level: LogLevel, message: string): Operation<void> {
      coreCtx.log(level, message);
      // Return a no-op operation so callers can yield* ctx.log(...)
      return {
        *[Symbol.iterator]() {
          // No-op - logging is fire-and-forget
        },
      };
    },

    notify(message: string, progressValue?: number, level?: LogLevel): Operation<void> {
      if (level) return ctx.log(level, message);
      coreCtx.progress(message, progressValue);
      return {
        *[Symbol.iterator]() {
          // The worker transport currently acknowledges notification delivery synchronously.
        },
      };
    },

    // Sample - delegates to sampleImpl (overloads are defined in the interface)
    sample: ((config: ToolSampleConfig<ExtendedMessage>) =>
      sampleImpl(config)) as WorkerToolContext["sample"],

    *sampleTools(config: SampleToolsConfig<ExtendedMessage>): Operation<SampleToolsResult> {
      const retries = config.retries ?? 2;
      let lastResult:
        | SampleResultBase
        | SampleResultWithParsed<unknown>
        | SampleResultWithToolCalls
        | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with tools
        const sampleConfig: SampleConfigToolsPrompt | SampleConfigToolsMessages<ExtendedMessage> =
          "prompt" in config
            ? {
                prompt: config.prompt,
                tools: config.tools,
                toolChoice: config.toolChoice ?? "required",
                ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
                ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
                ...(config.modelPreferences !== undefined && {
                  modelPreferences: config.modelPreferences,
                }),
              }
            : {
                messages: config.messages,
                tools: config.tools,
                toolChoice: config.toolChoice ?? "required",
                ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
                ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
                ...(config.modelPreferences !== undefined && {
                  modelPreferences: config.modelPreferences,
                }),
              };

        const result = yield* sampleImpl(sampleConfig);
        lastResult = result;

        // Check if we got tool calls
        if ("toolCalls" in result && isNonEmpty(result.toolCalls)) {
          return {
            text: result.text,
            ...(result.model !== undefined && { model: result.model }),
            stopReason: "toolUse",
            toolCalls: result.toolCalls,
            exchange: result.exchange,
          };
        }

        // If this wasn't the last attempt, we could add a retry hint
        // For now, just retry with the same config
      }

      throw new SampleValidationError(
        "sampleTools",
        retries + 1,
        lastResult!,
        `Model did not return tool calls after ${retries + 1} attempts`,
      );
    },

    *sampleSchema<T>(
      config: SampleSchemaConfig<T, ExtendedMessage>,
    ): Operation<SampleSchemaResult<T>> {
      const retries = config.retries ?? 2;
      let lastResult: SampleResultWithParsed<T> | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with schema
        const sampleConfig:
          | SampleConfigSchemaPrompt<T>
          | SampleConfigSchemaMessages<T, ExtendedMessage> =
          "prompt" in config
            ? {
                prompt: config.prompt,
                schema: config.schema,
                ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
                ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
                ...(config.modelPreferences !== undefined && {
                  modelPreferences: config.modelPreferences,
                }),
              }
            : {
                messages: config.messages,
                schema: config.schema,
                ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
                ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
                ...(config.modelPreferences !== undefined && {
                  modelPreferences: config.modelPreferences,
                }),
              };

        const result = yield* sampleTyped(sampleConfig);
        lastResult = result;

        // Check if we got valid parsed output
        if (result.parsed !== null) {
          return {
            text: result.text,
            ...(result.model !== undefined && { model: result.model }),
            ...(result.stopReason !== undefined && { stopReason: result.stopReason }),
            parsed: result.parsed,
            // Rebuild with the narrowed parsed value (SampleExchange<T | null> → SampleExchange<T>)
            exchange: { ...result.exchange, parsed: result.parsed },
          };
        }

        // If this wasn't the last attempt, we could add a retry hint
      }

      throw new SampleValidationError(
        "sampleSchema",
        retries + 1,
        lastResult!,
        `Schema parsing failed after ${retries + 1} attempts: ${lastResult?.parseError?.message ?? "unknown error"}`,
      );
    },

    *elicit(key, options) {
      const response: WorkerElicitResponse = yield* coreCtx.elicit(key, options);
      return { ...response.completion, exchangeId: response.id };
    },
  };

  return ctx;
}

// =============================================================================
// SIMPLE TOOL REGISTRY
// =============================================================================

/**
 * Create a simple in-memory tool registry.
 *
 * @param tools - Array of tools to register
 * @returns The registry
 */
export function createWorkerToolRegistry(tools: WorkerTool[]): WorkerToolRegistry {
  const map = new Map<string, WorkerTool>();
  for (const tool of tools) {
    map.set(tool.name, tool);
  }

  return {
    get(name: string) {
      return map.get(name) ?? null;
    },
    list() {
      return Array.from(map.keys());
    },
  };
}
