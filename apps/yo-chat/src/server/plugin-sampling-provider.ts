import type { ChatMessage, ChatToolCall, ChatToolDefinition } from "@sweatpants/chat-contract";
import type { Operation } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import type {
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
import {
  assistantText,
  parseStructuredSampleText,
  samplingToolCalls,
} from "@sweatpants/model-sampling";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import { createPiAiModelProviderDriver, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import type { ModelContext } from "@sweatpants/model-provider";
import { env } from "@/env";

interface SamplingOptions {
  systemPrompt?: string;
  maxTokens?: number;
  tools?: ChatToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  schema?: JsonObject;
}

function isSchemaToolCall(toolCall: ChatToolCall): boolean {
  return toolCall.name === "__schema__" || toolCall.name === "schema__";
}

function modelContext(messages: ChatMessage[], options: SamplingOptions | undefined): ModelContext {
  return {
    messages: [
      ...(options?.systemPrompt
        ? [{ role: "system" as const, content: options.systemPrompt }]
        : []),
      ...messages,
    ],
    tools: options?.tools ?? [],
  };
}

export function createPluginSamplingProvider(): ToolSessionSamplingProvider {
  const driver = createPiAiModelProviderDriver();
  const model = resolvePiAiModel({
    provider: env.DEFAULT_CHAT_MODEL_PROVIDER,
    id: env.DEFAULT_CHAT_MODEL_ID,
  });

  return {
    *sample(
      messages: ChatMessage[],
      options: SamplingOptions | undefined,
    ): Operation<SampleExchangeCompletion> {
      const modelMessages = messages;

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
      const toolCalls = samplingToolCalls(assistant);
      if (options?.schema) {
        const schemaToolCall = toolCalls.find(isSchemaToolCall);
        if (schemaToolCall) {
          const parsed = schemaToolCall.input;
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
