import type { Middleware, Operations } from "@sweatpants/standard-durability";
import {
  JournalEffectDeclarationError,
  type JournalRequest,
  type JournalTool,
  type ToolEffectSignature,
} from "@sweatpants/agent-sdk";
import { assertJson, type Json, type JsonObject } from "@sweatpants/foundation";
import { success, type Outcome, type IterableOperation } from "@sweatpants/foundation/computation";
import {
  decodeModelResponse,
  type Model,
  type ModelProviderStreamRequest,
  type ModelResponse,
  type StreamOptions,
  type ModelContext,
  type ModelStreamEvent,
} from "@sweatpants/model-provider";
import type { ChatMessage } from "@sweatpants/chat-contract";

/** Consume one model stream within the selected runtime's resource lifetime. */
export interface ChatModelStream<Y> {
  stream(
    request: ModelProviderStreamRequest,
    publish: (event: ModelStreamEvent) => void,
  ): IterableOperation<ModelResponse, Y>;
}

export interface ChatCapabilities<Y> {
  /** Runs in array order inside declaration validation; receives canonical input, returns raw output. */
  effectMiddleware?: readonly Middleware<ToolEffectSignature, Y>[];
  model: {
    model: Model;
    driver: ChatModelStream<Y>;
    streamOptions?: StreamOptions;
  };
  tools: readonly JournalTool[];
  effects: Readonly<Record<string, (input: Json) => IterableOperation<Outcome<Json, Json>, Y>>>;
}
export type ChatRequest =
  | JournalRequest
  | { kind: "sample"; iteration: number; context: Json }
  | {
      kind: "tool-result";
      iteration: number;
      callId: string;
      tool: string;
      output: Json;
      isError: boolean;
    };
export type TurnInput = { messageId: string; text: string; messages: Json; modelIdentity: string };

export function* chatWork<Q = never>(
  input: TurnInput,
  tools: readonly JournalTool[],
  sample?: (
    request: Extract<ChatRequest, { kind: "sample" }>,
  ) => IterableOperation<ModelResponse, Q>,
): IterableOperation<Json, ChatRequest | Q> {
  const messages = input.messages as unknown as ChatMessage[];
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.artifacts.parameters.inputProjection as JsonObject,
  }));
  for (let iteration = 0; iteration <= 10; iteration++) {
    const request: Extract<ChatRequest, { kind: "sample" }> = {
      kind: "sample",
      iteration,
      context: assertJson({ messages, tools: iteration < 10 ? declarations : [] }),
    };
    let sampled: unknown;
    if (sample) {
      sampled = yield* sample(request);
    } else {
      sampled = yield request;
    }
    const response = decodeModelResponse(sampled);
    if (response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    messages.push(response.message);
    const calls = response.message.content.filter((part) => part.type === "tool-call");
    if (!calls.length) {
      return assertJson({ messages });
    }
    if (iteration === 10) {
      throw new Error("Tool iteration limit exceeded");
    }
    if (new Set(calls.map((part) => part.toolCall.id)).size !== calls.length) {
      throw new Error("Duplicate tool call identity");
    }
    for (const { toolCall: call } of calls) {
      const tool = tools.find((entry) => entry.name === call.name);
      if (!tool) {
        throw new Error(`Unsupported tool: ${call.name}`);
      }
      let output: Json;
      let isError = false;
      try {
        output = yield* tool.invoke(call.input, call.id);
      } catch (error) {
        // Non-finite calculator output remains a visible turn failure.
        if (tool.name === "calculator") {
          throw error;
        }
        output = { error: error instanceof Error ? error.message : String(error) };
        isError = true;
      }
      // Publish only accepted results, including deterministic tool computations.
      yield { kind: "tool-result", iteration, callId: call.id, tool: call.name, output, isError };
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: [{ type: "text", text: JSON.stringify(output) }],
        isError,
      });
    }
  }
  return assertJson({ messages });
}

export function* handleChatRequest<Y>(
  options: ChatCapabilities<Y>,
  request: ChatRequest,
  effects: Operations<ToolEffectSignature, Y>,
  publish: (event: ModelStreamEvent) => void = () => {},
): IterableOperation<Outcome<Json, Json>, Y> {
  if (request.kind === "progress" || request.kind === "tool-result") {
    return success(null);
  }
  if (request.kind === "sample" || request.kind === "nested-sample") {
    const nested = request.kind === "nested-sample";
    const response = decodeModelResponse(
      yield* options.model.driver.stream(
        {
          model: options.model.model,
          context: nested
            ? {
                messages: [{ role: "user", content: [{ type: "text", text: request.prompt }] }],
                tools: [],
              }
            : (request.context as unknown as ModelContext),
          options: {
            ...options.model.streamOptions,
            // CONDITIONAL-SPREAD: preserve caller token options for outer samples.
            ...(nested ? { maxTokens: request.maxTokens } : {}),
            // CONDITIONAL-SPREAD: preserve caller response format unless the nested sample declares one.
            ...(nested && request.schema
              ? { responseFormat: { type: "json_schema" as const, schema: request.schema } }
              : {}),
          },
        },
        publish,
      ),
    );
    if (response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    return success(
      nested
        ? {
            text: response.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          }
        : assertJson(response),
    );
  }
  if (request.kind !== "effect") {
    throw new Error("Cannot dispatch an elicitation");
  }
  const tool = options.tools.find((entry) => entry.name === request.tool);
  if (!tool || !(`${request.tool}.${request.key}` in options.effects)) {
    throw new Error("Effect implementation unavailable");
  }
  try {
    return yield* effects.effect(request);
  } catch (error) {
    if (error instanceof JournalEffectDeclarationError) {
      throw new Error("Effect implementation unavailable");
    }
    throw error;
  }
}

/** Keep complete accepted call/result groups; provisional and unfinished calls never enter inference history. */
export function acceptedMessages(
  input: TurnInput,
  entries: readonly import("@sweatpants/foundation/journal").AcceptedExchange[],
): Json[] {
  const messages = structuredClone(input.messages) as Json[];
  for (const entry of entries) {
    const request = entry.request as ChatRequest;
    if (request.kind !== "sample" || !entry.outcome.ok) {
      continue;
    }
    const response = decodeModelResponse(entry.outcome.value);
    const calls = response.message.content.filter((part) => part.type === "tool-call");
    const results = calls.map(({ toolCall }) =>
      entries.find((candidate) => {
        const result = candidate.request as ChatRequest;
        return (
          candidate.sequence > entry.sequence &&
          result.kind === "tool-result" &&
          result.iteration === request.iteration &&
          result.callId === toolCall.id
        );
      }),
    );
    if (results.some((result) => !result)) {
      break;
    }
    messages.push(assertJson(response.message));
    for (const result of results) {
      const accepted = result!.request as Extract<ChatRequest, { kind: "tool-result" }>;
      messages.push({
        role: "tool",
        name: accepted.tool,
        toolCallId: accepted.callId,
        content: [{ type: "text", text: JSON.stringify(accepted.output) }],
        isError: accepted.isError,
      });
    }
  }
  return messages;
}
