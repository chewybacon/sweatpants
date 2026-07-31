import type { Operation } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import { toToolParameterJsonSchema } from "@sweatpants/tool-session/tool-parameters";
import type {
  SamplingToolCall,
  SamplingToolDefinition,
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
import { toModelMessages, type ExtendedMessage } from "@sweatpants/tool-session/messages";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import { createPiAiModelProviderDriver, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import {
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
  type Tool as ModelTool,
} from "@sweatpants/model-provider";
import { env } from "@/env";

interface SamplingOptions {
  systemPrompt?: string;
  maxTokens?: number;
  tools?: SamplingToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  schema?: JsonObject;
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
      id: block.toolCall.id,
      name: block.toolCall.function.name,
      arguments: block.toolCall.function.arguments,
    }));
}

function samplingTools(tools: SamplingToolDefinition[] | undefined): ModelTool[] | undefined {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    // Sampling tools are authored at call time: this is their projection point.
    parameters: toToolParameterJsonSchema(tool.inputSchema),
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
    ): Operation<SampleExchangeCompletion> {
      const modelMessages = toModelMessages(messages);

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
          } satisfies ParsedSampleExchangeCompletion<unknown>;
        }

        try {
          return {
            text,
            model: model.id,
            stopReason: "endTurn",
            parsed: parseStructuredSampleText(text),
          } satisfies ParsedSampleExchangeCompletion<unknown>;
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
          } satisfies ParsedSampleExchangeCompletion<unknown>;
        }
      }

      if (toolCalls.length > 0) {
        return {
          text,
          model: model.id,
          stopReason: "toolUse",
          toolCalls,
        } satisfies ToolCallSampleExchangeCompletion;
      }

      return {
        text,
        model: model.id,
        stopReason: assistant.stopReason === "maxTokens" ? "maxTokens" : "endTurn",
      } satisfies SampleExchangeCompletionBase;
    },
  };
}
