import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Json } from "@sweatpants/foundation";
import { safeSchemaIssues, validateStandardSchema } from "@sweatpants/foundation/schema-validation";
import type { Operation } from "effection";
import { z } from "zod";
import type {
  ElicitExchange,
  ElicitExchangeCompletion,
  ParsedSampleExchangeCompletion,
  SampleExchange,
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ToolCallSampleExchangeCompletion,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  ToolElicitResult,
  ToolMessage,
} from "./types.ts";

const elicitExchangeCompletionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: z.json() }),
  z.strictObject({ action: z.literal("decline"), reason: z.string().optional() }),
  z.strictObject({ action: z.literal("cancel"), reason: z.string().optional() }),
]);

/** Owns structural restoration of an elicitation completion at JSON boundaries. */
export function parseElicitExchangeCompletion(value: unknown): ElicitExchangeCompletion<Json> {
  const parsed = elicitExchangeCompletionSchema.parse(value);
  if (parsed.action === "accept") return parsed;
  if (parsed.action === "decline") {
    return parsed.reason === undefined
      ? { action: "decline" }
      : { action: "decline", reason: parsed.reason };
  }
  return parsed.reason === undefined
    ? { action: "cancel" }
    : { action: "cancel", reason: parsed.reason };
}

export const SCHEMA_TOOL_NAME = "__schema__";

export function createRawSampleExchange(
  promptText: string,
  responseText: string,
): SampleExchange<undefined> {
  const request: ToolMessage & { role: "user" } = {
    role: "user",
    content: [{ type: "text", text: promptText }],
  };
  const response: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [{ type: "text", text: responseText }],
  };
  return { request, response, messages: [request, response], parsed: undefined };
}

export function createStructuredSampleExchange<T>(
  promptText: string,
  parsed: T,
  exchangeId: string,
): SampleExchange<T> {
  const request: ToolMessage & { role: "user" } = {
    role: "user",
    content: [{ type: "text", text: promptText }],
  };
  const toolUse: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: exchangeId,
        name: SCHEMA_TOOL_NAME,
        input: {},
      },
    ],
  };
  const responseText = JSON.stringify(parsed);
  if (responseText === undefined) {
    throw new Error("Structured sample completion produced a non-serializable value");
  }
  const toolResult: ToolMessage & { role: "user" } = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: exchangeId,
        content: [{ type: "text", text: responseText }],
      },
    ],
  };
  return {
    request,
    response: toolUse,
    messages: [request, toolUse, toolResult],
    parsed,
  };
}

export interface CompleteSampleExchangeOptions {
  readonly promptText: string;
  readonly completion: SampleExchangeCompletion;
  readonly exchangeId?: string;
}

/** Enriches transport-safe sample completion facts with local exchange history. */
export function completeSampleExchange(
  options: CompleteSampleExchangeOptions & {
    completion: ParsedSampleExchangeCompletion<unknown>;
  },
): SampleResultWithParsed<unknown>;
export function completeSampleExchange(
  options: CompleteSampleExchangeOptions & { completion: ToolCallSampleExchangeCompletion },
): SampleResultWithToolCalls;
export function completeSampleExchange(
  options: CompleteSampleExchangeOptions & { completion: SampleExchangeCompletionBase },
): SampleResultBase;
export function completeSampleExchange(
  options: CompleteSampleExchangeOptions,
): SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls;
export function completeSampleExchange(
  options: CompleteSampleExchangeOptions,
): SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls {
  const { completion } = options;
  if ("parsed" in completion) {
    if (completion.parsed !== null && options.exchangeId === undefined) {
      throw new Error("Structured sample exchange completion requires producer-owned identity");
    }
    const exchange =
      completion.parsed === null
        ? createRawSampleExchange(options.promptText, completion.text)
        : createStructuredSampleExchange(
            options.promptText,
            completion.parsed,
            options.exchangeId!,
          );
    return { ...completion, exchange };
  }
  const exchange = createRawSampleExchange(options.promptText, completion.text);
  if ("toolCalls" in completion) return { ...completion, exchange };
  return { ...completion, exchange };
}

export interface CompleteElicitExchangeOptions<TContext, TResponse> {
  readonly key: string;
  readonly message: string;
  readonly context: TContext;
  readonly exchangeId: string;
  readonly responseSchema: StandardSchemaV1<unknown, TResponse>;
  readonly completion: ElicitExchangeCompletion<unknown>;
}

/**
 * Completes one authored elicitation exchange.
 *
 * Transport and protocol layers carry only `ElicitExchangeCompletion<unknown>`.
 * This authority runs the authored Standard Schema, preserves its transformed
 * output, and constructs the local history exchange exactly once.
 */
export function* completeElicitExchange<TContext, TResponse>(
  options: CompleteElicitExchangeOptions<TContext, TResponse>,
): Operation<ToolElicitResult<TContext, TResponse>> {
  const { completion } = options;
  if (completion.action === "decline") {
    return completion.reason === undefined
      ? { action: "decline" }
      : { action: "decline", reason: completion.reason };
  }
  if (completion.action === "cancel") {
    return completion.reason === undefined
      ? { action: "cancel" }
      : { action: "cancel", reason: completion.reason };
  }

  const parsed = yield* validateStandardSchema(options.responseSchema, completion.content);
  if (parsed.issues !== undefined) {
    const issues = safeSchemaIssues(parsed.issues)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .join("; ");
    throw new Error(`Elicit response validation failed for key "${options.key}": ${issues}`);
  }

  const responseText = JSON.stringify(parsed.value);
  if (responseText === undefined) {
    throw new Error(
      `Elicit response validation for key "${options.key}" produced a non-serializable value`,
    );
  }

  const request: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [
      { type: "text", text: options.message },
      {
        type: "tool_use",
        id: options.exchangeId,
        name: options.key,
        input: {},
      },
    ],
  };
  const response: ToolMessage & { role: "user" } = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: options.exchangeId,
        content: [{ type: "text", text: responseText }],
      },
    ],
  };
  const exchange: ElicitExchange<TContext> = {
    context: options.context,
    request,
    response,
    messages: [request, response],
    withArguments(fn: (context: TContext) => Json): [ToolMessage, ToolMessage] {
      const requestWithArguments: ToolMessage & { role: "assistant" } = {
        role: "assistant",
        content: [
          { type: "text", text: options.message },
          {
            type: "tool_use",
            id: options.exchangeId,
            name: options.key,
            input: fn(options.context),
          },
        ],
      };
      return [requestWithArguments, response];
    },
  };

  return { action: "accept", content: parsed.value, exchange };
}
