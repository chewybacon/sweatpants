import { assertJson, canonicalJson } from "@sweatpants/foundation";
import type { Operation } from "effection";
import {
  completeSampleExchange,
  createStructuredSampleExchange,
  type SampleExchangeCompletionBase,
  type ParsedSampleExchangeCompletion,
  toPortableSchema,
} from "@sweatpants/agent-sdk";
import { z } from "zod";
import type { ChatMessage } from "@sweatpants/chat-contract";
import { exchangeSchema, exchangeMessages, projectExchange } from "./exchanges.ts";
import { responseSchema } from "./response-schema.ts";

export const samplingDescription =
  "Request a model completion. Returns status ok, text, and exchange.messages for explicit history accumulation. Supply prior exchanges in order; they are not inherited automatically. Optional context is selected JSON state for this request only. Optional schema is a JSON Schema response contract: on success parsed contains validated data; on validation failure status invalid has parseError and no exchange. Branch on status before using parsed. Supported schema keywords: type, description, properties, required, additionalProperties (boolean), items, enum and const (JSON scalars), anyOf, minimum, maximum, minLength, maxLength, minItems, maxItems. Constraints require an explicit type; required fields must be declared in properties. No refs. Interpret corrections against current state and relevant exchanges before applying changes. Text and structured samples inherit the calling model thinking setting; optional thinking overrides it explicitly. No callable tools are exposed. maxTokens defaults to 4096, including reasoning; prefer this default even for short answers.";
export const samplingParameters = z.object({
  prompt: z.string().min(1).max(32_768),
  context: z.json().optional(),
  exchanges: z.array(exchangeSchema).max(128).optional(),
  schema: z.record(z.string(), z.json()).optional(),
  systemPrompt: z.string().max(8192).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});
export const samplingOutput = z.union([
  z.object({
    status: z.literal("ok"),
    text: z.string(),
    parsed: z.json().optional(),
    exchange: exchangeSchema,
  }),
  z.object({
    status: z.literal("invalid"),
    text: z.string(),
    parseError: z.object({ message: z.string() }),
  }),
]);
export const samplingContract = {
  name: "sample",
  description: samplingDescription,
  parameters: toPortableSchema(samplingParameters, {
    identity: "tool:sample/parameters",
    role: "tool_parameters",
    version: "0.0.1",
  }).descriptor.inputProjection,
  output: toPortableSchema(samplingOutput, {
    identity: "tool:sample/output",
    role: "tool_output",
    version: "0.0.1",
  }).descriptor.outputProjection,
};
export const samplingIdentity = "yo-workflow.sample@0.0.1:native-inherited-thinking-v5";
type SamplingRequest = {
  prompt?: string;
  messages?: readonly ChatMessage[];
  systemPrompt?: string;
  maxTokens: number;
  thinking?: z.infer<typeof samplingParameters>["thinking"];
};
export interface SamplingContext {
  sample(request: SamplingRequest): Operation<SampleExchangeCompletionBase>;
  sampleSchema?<T>(
    request: SamplingRequest & { schema: z.ZodType<T> },
  ): Operation<ParsedSampleExchangeCompletion<T> & { parsed: T }>;
}

export function* sampleCompletion(
  input: z.infer<typeof samplingParameters>,
  context: SamplingContext,
  exchangeId?: string,
): Operation<z.infer<typeof samplingOutput>> {
  const prompt =
    input.context === undefined
      ? input.prompt
      : `${input.prompt}\n\nExplicit context (JSON data):\n${canonicalJson(input.context)}`;
  const history = exchangeMessages(input.exchanges ?? []);
  const messages: ChatMessage[] = [...history, { role: "user", content: prompt }];
  if (
    new TextEncoder().encode(canonicalJson(assertJson({ messages, schema: input.schema ?? null })))
      .length > 32_768
  ) {
    throw new Error("Sampling history, prompt, context, and schema exceed 32 KiB");
  }
  const request = {
    ...(history.length === 0 ? { prompt } : { messages }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    maxTokens: input.maxTokens ?? 4096,
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  };
  if (input.schema !== undefined) {
    if (!context.sampleSchema || !exchangeId) {
      throw new Error(
        "Structured sampling requires a runtime sampling capability and exchange identity",
      );
    }
    const schema = responseSchema(input.schema);
    try {
      const result = yield* context.sampleSchema({ ...request, schema });
      // sampleSchema has validated the value, including a legitimate JSON null.
      const exchange = createStructuredSampleExchange(prompt, result.parsed, exchangeId);
      return {
        status: "ok",
        text: result.text,
        parsed: assertJson(result.parsed),
        exchange: projectExchange(exchange),
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "schema_validation_failed"
      ) {
        throw error;
      }
      // Validation failure is an observable workflow outcome; provider/cancellation errors propagate.
      return { status: "invalid", text: "", parseError: { message: error.message } };
    }
  }
  const result = yield* context.sample(request);
  const completed = completeSampleExchange({ promptText: prompt, completion: result });
  return { status: "ok", text: result.text, exchange: projectExchange(completed.exchange) };
}
