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
  type WorkerContentBlock,
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
import {
  type ChatContent,
  type ChatContentPart,
  type ChatMessage,
  type ChatMessagePart,
} from "@sweatpants/chat-contract";
import { UnsupportedModelCapabilityError } from "@sweatpants/model-provider";
import type { WorkerTool, WorkerToolRegistry, WorkerToolContext } from "./worker-types.js";
import { toToolParameterJsonSchema } from "@sweatpants/tool-session/tool-parameters";

// =============================================================================
// TYPE CONVERSION HELPERS
// =============================================================================

/** Encode canonical Chat messages at the worker protocol boundary. */
function toWorkerMessage(message: ChatMessage): WorkerMessage {
  switch (message.role) {
    case "system":
    case "developer":
      throw new UnsupportedModelCapabilityError(
        "$.message",
        message.role,
        "worker sampling carries system text through systemPrompt",
      );
    case "user":
      return { role: "user", content: workerContent(message.content, "$.message.content") };
    case "assistant":
      return { role: "assistant", content: workerAssistantContent(message.content) };
    case "tool":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: message.toolCallId,
            content: workerTextContent(message.content, "$.message.content"),
            isError: message.isError,
          },
        ],
      };
  }
}

function workerContent(content: ChatContent, path: string): WorkerMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((part, index) => workerContentPart(part, `${path}[${index}]`));
}

function workerContentPart(part: ChatContentPart, path: string): WorkerContentBlock {
  if (part.type === "text") return { type: "text", text: part.text };
  throw new UnsupportedModelCapabilityError(
    path,
    part.type,
    `worker sampling cannot encode ${part.type}`,
  );
}

function workerAssistantContent(parts: readonly ChatMessagePart[]): WorkerContentBlock[] {
  return parts.map((part, index) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "tool-call") {
      return {
        type: "tool_use",
        id: part.toolCall.id,
        name: part.toolCall.name,
        input: part.toolCall.input,
      };
    }
    throw new UnsupportedModelCapabilityError(
      `$.message.content[${index}]`,
      part.type,
      `worker sampling cannot encode ${part.type}`,
    );
  });
}

function workerTextContent(
  content: ChatContent,
  path: string,
): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part, index) => {
    if (part.type === "text") return { type: "text", text: part.text };
    throw new UnsupportedModelCapabilityError(
      path + `[${index}]`,
      part.type,
      "worker tool results support text only",
    );
  });
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
  function extractPromptText(config: ToolSampleConfig<ChatMessage>): string {
    if ("prompt" in config && config.prompt) {
      return config.prompt;
    }
    if ("messages" in config && config.messages) {
      const lastUserMsg = [...config.messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        return typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      }
    }
    return "";
  }

  // Helper to build messages for core sample
  function buildMessages(config: ToolSampleConfig<ChatMessage>): WorkerMessage[] {
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
      config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T, ChatMessage>,
    ): Operation<SampleResultWithParsed<T>>;
    (
      config: SampleConfigToolsPrompt | SampleConfigToolsMessages<ChatMessage>,
    ): Operation<SampleResultWithToolCalls>;
    (
      config: ToolSampleConfig<ChatMessage>,
    ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
  }
  const sampleTyped = sampleImpl as SampleTyped;
  function* sampleImpl(
    config: ToolSampleConfig<ChatMessage>,
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
    sample: ((config: ToolSampleConfig<ChatMessage>) =>
      sampleImpl(config)) as WorkerToolContext["sample"],

    *sampleTools(config: SampleToolsConfig<ChatMessage>): Operation<SampleToolsResult> {
      const retries = config.retries ?? 2;
      let lastResult:
        | SampleResultBase
        | SampleResultWithParsed<unknown>
        | SampleResultWithToolCalls
        | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with tools
        const sampleConfig: SampleConfigToolsPrompt | SampleConfigToolsMessages<ChatMessage> =
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

    *sampleSchema<T>(config: SampleSchemaConfig<T, ChatMessage>): Operation<SampleSchemaResult<T>> {
      const retries = config.retries ?? 2;
      let lastResult: SampleResultWithParsed<T> | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Build sample config with schema
        const sampleConfig:
          | SampleConfigSchemaPrompt<T>
          | SampleConfigSchemaMessages<T, ChatMessage> =
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
