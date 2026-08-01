import type { Operation } from "effection";
import type { JsonObject } from "@sweatpants/foundation";
import type {
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";
import { toModelMessages, type ExtendedMessage } from "@sweatpants/tool-session/messages";
import {
  assistantText,
  parseStructuredSampleText,
  samplingToolCalls,
  type ModelSampleToolCall,
} from "@sweatpants/model-sampling";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import { createPiAiModelProviderDriver, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import {
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type PortableModelContextMessage,
  type PortableModelTool,
} from "@sweatpants/model-provider";
import { env } from "@/env";

interface SamplingOptions {
  systemPrompt?: string;
  maxTokens?: number;
  tools?: PortableModelTool[];
  toolChoice?: "auto" | "required" | "none";
  schema?: JsonObject;
}

function isSchemaToolCall(toolCall: ModelSampleToolCall): boolean {
  return toolCall.name === "__schema__" || toolCall.name === "schema__";
}

function modelContext(
  messages: PortableModelContextMessage[],
  options: SamplingOptions | undefined,
): ModelContext {
  const context: ModelContext = {
    messages,
    ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  };

  if (options?.tools) {
    context.tools = options.tools;
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
      const toolCalls = samplingToolCalls(assistant);
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
