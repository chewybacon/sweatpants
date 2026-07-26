import { run } from "effection";
import type { Message } from "../../../packages/framework/src/lib/chat/types.ts";
import type {
  ExtendedMessage,
  WireSampleResult,
  WireSampleResultBase,
  WireSampleResultWithParsed,
  WireSampleResultWithToolCalls,
  SamplingToolCall,
  SamplingToolDefinition,
} from "../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts";
import { extendedMessageToProviderMessage } from "../../../packages/framework/src/lib/chat/mcp-tools/message-conversion.ts";
import {
  createPiAiModelProviderDriver,
  modelSelectionKey,
  resolvePiAiModel,
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
  type ModelSelection,
  type Tool as ModelTool,
} from "../../../packages/model-provider-pi-ai/src/index.ts";

export type AgentCoreToolSampleMode = "host" | "internal";

export interface AgentCoreToolSampleConfig {
  mode: AgentCoreToolSampleMode;
  explicitModel?: ModelSelection | undefined;
}

export interface InternalSampleRequest {
  inheritedModel?: ModelSelection | undefined;
  messages: unknown[];
  systemPrompt?: string | undefined;
  maxTokens?: number | undefined;
  tools?: unknown[] | undefined;
  toolChoice?: unknown;
  schema?: Record<string, unknown> | undefined;
}

type ProviderAssistantToolCall = NonNullable<Message["tool_calls"]>[number];

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readAgentCoreToolSampleConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentCoreToolSampleConfig {
  const rawMode = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODE"]) ?? "host";
  if (rawMode !== "host" && rawMode !== "internal") {
    throw new Error(`AGENTCORE_TOOL_SAMPLE_MODE must be "host" or "internal"; received ${rawMode}`);
  }

  const provider = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER"]);
  const id = nonEmptyEnv(env["AGENTCORE_TOOL_SAMPLE_MODEL_ID"]);
  if ((provider && !id) || (!provider && id)) {
    throw new Error(
      "AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER and AGENTCORE_TOOL_SAMPLE_MODEL_ID must be set together",
    );
  }

  return {
    mode: rawMode,
    ...(provider && id ? { explicitModel: { provider, id } } : {}),
  };
}

export function selectInternalSampleModel(
  config: AgentCoreToolSampleConfig,
  inheritedModel: ModelSelection | undefined,
): ModelSelection {
  if (config.explicitModel) {
    return config.explicitModel;
  }
  if (inheritedModel) {
    return inheritedModel;
  }
  throw new Error(
    "AgentCore internal sampling requires start_tool_session.context.model or explicit AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER/ID",
  );
}

function assertAgentCoreUsableModel(selection: ModelSelection): void {
  const appOnlyProviders = new Set(["ollama", "github-copilot"]);
  if (appOnlyProviders.has(selection.provider)) {
    throw new Error(
      `AgentCore internal sampling cannot use app-local model ${modelSelectionKey(selection)}; configure AGENTCORE_TOOL_SAMPLE_MODE=host or set AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER/ID to an AgentCore-reachable model`,
    );
  }
}

function providerMessageToModelMessage(message: Message): ModelMessage {
  if (message.role === "system") {
    return { role: "system", content: message.content };
  }

  if (message.role === "user") {
    return { role: "user", content: message.content };
  }

  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.tool_call_id ?? "",
      toolName: message.replay?.toolName ?? "",
      content: [{ type: "text", text: message.content }],
      isError: message.content.startsWith("Error:"),
    };
  }

  return {
    role: "assistant",
    content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.tool_calls ?? []).map((toolCall: ProviderAssistantToolCall) => ({
        type: "toolCall" as const,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
    ],
  };
}

function assistantText(message: ModelAssistantMessage): string {
  return message.content
    .filter(
      (block): block is Extract<ModelAssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function assistantToolCalls(message: ModelAssistantMessage): SamplingToolCall[] {
  return message.content
    .filter(
      (block): block is Extract<ModelAssistantMessage["content"][number], { type: "toolCall" }> =>
        block.type === "toolCall",
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    }));
}

function samplingTools(tools: unknown[] | undefined): ModelTool[] | undefined {
  return (tools as SamplingToolDefinition[] | undefined)?.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters:
      typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {}, required: [] },
  }));
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

function extractFencedJson(text: string): string | undefined {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  return match?.[1]?.trim();
}

function extractBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }
    if (char === opener) {
      depth += 1;
    }
    if (char === closer) {
      depth -= 1;
    }
    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return undefined;
}

export function parseStructuredSampleText(text: string): unknown {
  const candidates = [
    text,
    stripThinkingBlocks(text),
    extractFencedJson(text),
    extractBalancedJson(stripThinkingBlocks(text)),
    extractBalancedJson(text),
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to parse JSON");
}

function isSchemaToolCall(toolCall: SamplingToolCall): boolean {
  return toolCall.name === "__schema__" || toolCall.name === "schema__";
}

function modelContext(messages: ModelMessage[], request: InternalSampleRequest): ModelContext {
  const context: ModelContext = {
    messages,
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
  };

  const tools = samplingTools(request.tools);
  if (tools) {
    context.tools = tools;
  }
  return context;
}

function rawResultFromAssistant(
  assistant: ModelAssistantMessage,
  model: ModelSelection,
  request: InternalSampleRequest,
): WireSampleResult {
  const text = assistantText(assistant);
  const toolCalls = assistantToolCalls(assistant);
  const modelName = modelSelectionKey(model);

  if (request.schema) {
    const schemaToolCall = toolCalls.find(isSchemaToolCall);
    if (schemaToolCall) {
      const parsed = schemaToolCall.arguments;
      return {
        text: text || JSON.stringify(parsed),
        model: modelName,
        stopReason: "endTurn",
        parsed,
      } satisfies WireSampleResultWithParsed<unknown>;
    }

    try {
      return {
        text,
        model: modelName,
        stopReason: "endTurn",
        parsed: parseStructuredSampleText(text),
      } satisfies WireSampleResultWithParsed<unknown>;
    } catch (error) {
      return {
        text,
        model: modelName,
        stopReason: "endTurn",
        parsed: null,
        parseError: {
          message: error instanceof Error ? error.message : "Failed to parse JSON",
          rawText: text,
        },
      } satisfies WireSampleResultWithParsed<unknown>;
    }
  }

  if (toolCalls.length > 0) {
    return {
      text,
      model: modelName,
      stopReason: "toolUse",
      toolCalls,
    } satisfies WireSampleResultWithToolCalls;
  }

  return {
    text,
    model: modelName,
    stopReason:
      assistant.stopReason === "maxTokens" || assistant.stopReason === "length"
        ? "maxTokens"
        : "endTurn",
  } satisfies WireSampleResultBase;
}

function toModelMessages(messages: unknown[]): ModelMessage[] {
  return (messages as ExtendedMessage[])
    .map(extendedMessageToProviderMessage)
    .map(providerMessageToModelMessage);
}

export async function sampleInsideAgentCore(
  request: InternalSampleRequest,
): Promise<WireSampleResult> {
  const config = readAgentCoreToolSampleConfig();
  if (config.mode !== "internal") {
    throw new Error(
      "sampleInsideAgentCore called while AGENTCORE_TOOL_SAMPLE_MODE is not internal",
    );
  }

  const selection = selectInternalSampleModel(config, request.inheritedModel);
  assertAgentCoreUsableModel(selection);
  const model = resolvePiAiModel(selection);
  const driver = createPiAiModelProviderDriver();
  const assistant = await run(function* () {
    return yield* driver.sample({
      model,
      context: modelContext(toModelMessages(request.messages), request),
      options: {
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.toolChoice === "auto" ||
        request.toolChoice === "required" ||
        request.toolChoice === "none"
          ? { toolChoice: request.toolChoice }
          : {}),
        ...(request.schema
          ? {
              responseFormat: {
                type: "json_schema" as const,
                name: "agentcore_tool_sample",
                schema: request.schema,
              },
            }
          : {}),
      },
    });
  });

  return rawResultFromAssistant(assistant, selection, request);
}
