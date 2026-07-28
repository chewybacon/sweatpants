import type { Operation } from "effection";
import type {
  ExtendedMessage,
  Message,
  SamplingToolCall,
  SamplingToolDefinition,
} from "@sweatpants/framework/chat";
import { extendedMessageToProviderMessage } from "@sweatpants/framework/chat/mcp-tools";
import type {
  ToolSessionSamplingProvider,
  WireSampleResult,
  WireSampleResultBase,
  WireSampleResultWithParsed,
  WireSampleResultWithToolCalls,
} from "@sweatpants/tool-session";
import {
  createPiAiModelProviderDriver,
  resolvePiAiModel,
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
  type Tool as ModelTool,
} from "@sweatpants/model-provider-pi-ai";
import { env } from "@/env";

interface SamplingOptions {
  systemPrompt?: string;
  maxTokens?: number;
  tools?: SamplingToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  schema?: Record<string, unknown>;
}

type ProviderAssistantToolCall = NonNullable<Message["tool_calls"]>[number];

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

function samplingTools(tools: SamplingToolDefinition[] | undefined): ModelTool[] | undefined {
  return tools?.map((tool) => ({
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

function parseStructuredSampleText(text: string): unknown {
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

function modelContext(
  messages: ModelMessage[],
  options: SamplingOptions | undefined,
): ModelContext {
  const context: ModelContext = {
    messages,
    ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  };

  const tools = samplingTools(options?.tools);
  if (tools) {
    context.tools = tools;
  }

  return context;
}

export function createPluginSamplingProvider(): ToolSessionSamplingProvider {
  const driver = createPiAiModelProviderDriver();
  const model = resolvePiAiModel({
    provider: env.DEFAULT_CHAT_MODEL_PROVIDER,
    id: env.DEFAULT_CHAT_MODEL_ID,
  });

  return {
    *sample(
      messages: ExtendedMessage[],
      options: SamplingOptions | undefined,
    ): Operation<WireSampleResult> {
      const modelMessages = messages
        .map(extendedMessageToProviderMessage)
        .map(providerMessageToModelMessage);

      const assistant = yield* driver.sample({
        model,
        context: modelContext(modelMessages, options),
        options: {
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
          ...(options?.schema
            ? {
                responseFormat: {
                  type: "json_schema",
                  name: "plugin_sample",
                  schema: options.schema,
                },
              }
            : {}),
        },
      });

      const text = assistantText(assistant);
      const toolCalls = assistantToolCalls(assistant);
      if (options?.schema) {
        const schemaToolCall = toolCalls.find(isSchemaToolCall);
        if (schemaToolCall) {
          const parsed = schemaToolCall.arguments;
          return {
            text: text || JSON.stringify(parsed),
            model: model.id,
            stopReason: "endTurn",
            parsed,
          } satisfies WireSampleResultWithParsed<unknown>;
        }

        try {
          return {
            text,
            model: model.id,
            stopReason: "endTurn",
            parsed: parseStructuredSampleText(text),
          } satisfies WireSampleResultWithParsed<unknown>;
        } catch (error) {
          return {
            text,
            model: model.id,
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
          model: model.id,
          stopReason: "toolUse",
          toolCalls,
        } satisfies WireSampleResultWithToolCalls;
      }

      return {
        text,
        model: model.id,
        stopReason: assistant.stopReason === "maxTokens" ? "maxTokens" : "endTurn",
      } satisfies WireSampleResultBase;
    },
  };
}
