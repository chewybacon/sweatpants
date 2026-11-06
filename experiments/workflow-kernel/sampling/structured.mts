import { z } from "zod";
import type { ModelProvider } from "../../../packages/v2/providers/src/index.ts";
import type { Stream } from "../../../packages/v2/runtime/src/index.ts";
import type { ModelStreamEvent } from "../../../packages/v2/providers/src/index.ts";
import type { SampleRequest, SampleResponse } from "./contracts.mts";
import { sampleStream, type SampleModel } from "./provider.mts";

export type StructuredSample<T> =
  | { valid: true; value: T; sample: SampleResponse }
  | { valid: false; reason: "invalid-json" | "schema-mismatch"; sample: SampleResponse };

/** Pure terminal projection: a completed invalid answer is still an accepted sample.
 * No repair, retry, coercion, fenced-JSON extraction or provider-native schema mode. */
export function sampleSchemaStream<S extends z.ZodType, Y>(
  provider: ModelProvider<Y>,
  model: SampleModel,
  request: SampleRequest,
  schema: S,
): Stream<ModelStreamEvent, StructuredSample<z.output<S>>, Y> {
  const instruction =
    "Return only JSON matching this schema: " + JSON.stringify(z.toJSONSchema(schema));
  return {
    *[Symbol.iterator]() {
      const source = yield* sampleStream(provider, model, {
        ...request,
        systemPrompt: [request.systemPrompt, instruction].filter(Boolean).join("\n\n"),
      });
      return {
        *next() {
          const item = yield* source.next();
          if (!item.done) {
            return item;
          }
          const sample = item.value;
          let json: unknown;
          try {
            json = JSON.parse(sample.text);
          } catch {
            return {
              done: true as const,
              value: { valid: false as const, reason: "invalid-json" as const, sample },
            };
          }
          const parsed = schema.safeParse(json);
          const value: StructuredSample<z.output<S>> = parsed.success
            ? { valid: true, value: parsed.data, sample }
            : { valid: false, reason: "schema-mismatch", sample };
          return { done: true as const, value };
        },
      };
    },
  };
}
