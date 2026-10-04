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
import { ModelProviderPort, useModel, useStreamOptions } from "@sweatpants/model-provider";
import type { ModelContext, ChatModel } from "@sweatpants/model-provider";

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

export function createModelSamplingProvider(config?: ChatModel): ToolSessionSamplingProvider {
  return {
    *sample(
      messages: ChatMessage[],
      options: SamplingOptions | undefined,
    ): Operation<SampleExchangeCompletion> {
      const model = config?.model ?? (yield* useModel());
      const streamOptions = config?.streamOptions ?? (yield* useStreamOptions());
      const modelMessages = messages;

      const assistant = yield* (config?.driver ?? ModelProviderPort.api.operations).sample({
        model,
        context: modelContext(modelMessages, options),
        options: {
          ...streamOptions,
          maxTokens: options?.maxTokens ?? streamOptions?.maxTokens,
          toolChoice: options?.toolChoice ?? streamOptions?.toolChoice,
          responseFormat: options?.schema
            ? { type: "json_schema", name: "plugin_sample", schema: options.schema }
            : streamOptions?.responseFormat,
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
