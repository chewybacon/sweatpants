import { z } from "zod";
import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import { defineDurableEffect } from "@sweatpants/durable-effects";

export const decisionBindingSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
});
export type DecisionBinding = z.infer<typeof decisionBindingSchema>;

const label = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const probability = z.number().min(0).max(1);
export const decisionRequestSchema = z
  .strictObject({
    input: z.json(),
    question: z.strictObject({
      type: z.literal("choice"),
      instructions: z.string().min(1).max(8192),
      choices: z
        .array(z.strictObject({ value: label, description: z.string().max(8192) }))
        .min(2)
        .max(64),
    }),
  })
  .superRefine((request, ctx) => {
    const labels = request.question.choices.map((choice) => choice.value);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", message: "Decision choices must be unique" });
    }
    if (new TextEncoder().encode(canonicalJson(request.input)).byteLength > 32768) {
      ctx.addIssue({ code: "custom", message: "Decision input exceeds 32 KiB" });
    }
  });
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export const decisionEffectInputSchema = z.strictObject({
  binding: decisionBindingSchema,
  request: decisionRequestSchema,
});
export type DecisionEffectInput = z.infer<typeof decisionEffectInputSchema>;
export const decisionAnswerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    choice: label,
    confidence: probability,
    probabilities: z
      .array(z.strictObject({ value: label, probability }))
      .min(2)
      .max(64),
  }),
  z.strictObject({ type: z.literal("refusal") }),
]);
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;
export const decisionResultSchema = z.strictObject({
  answer: decisionAnswerSchema,
  model: decisionBindingSchema,
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type DecisionResult = z.infer<typeof decisionResultSchema>;

export class DecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

/** Mandatory request-dependent checks, including for substituted provider drivers. */
export function validateDecisionResult(request: DecisionRequest, raw: unknown): DecisionResult {
  const parsed = decisionResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DecisionError("decision_response_invalid", "Invalid decision response shape");
  }
  const result = parsed.data;
  if (result.answer.type === "refusal") {
    return result;
  }
  const answer = result.answer;
  const labels = new Set(request.question.choices.map((choice) => choice.value));
  const returned = answer.probabilities.map((entry) => entry.value);
  const sum = answer.probabilities.reduce((total, entry) => total + entry.probability, 0);
  const selected = answer.probabilities.find((entry) => entry.value === answer.choice);
  if (
    !labels.has(answer.choice) ||
    returned.length !== labels.size ||
    new Set(returned).size !== labels.size ||
    returned.some((value) => !labels.has(value)) ||
    Math.abs(sum - 1) > 0.0001 ||
    !selected ||
    answer.probabilities.some((entry) => entry.probability > selected.probability + 0.000001)
  ) {
    throw new DecisionError(
      "decision_response_invalid",
      "Decision choice or distribution does not match the request",
    );
  }
  return result;
}

function schemaBinding(
  schema: typeof decisionEffectInputSchema | typeof decisionResultSchema,
  role: "effect_input" | "effect_output",
): SchemaBinding {
  const projection = assertJson(z.toJSONSchema(schema));
  return {
    descriptor: createPortableSchemaDescriptor({
      identity: `effect:model.decision/${role}`,
      version: "1",
      role,
      vendor: "sweatpants",
      inputProjection: projection,
      outputProjection: projection,
      fidelity: { input: "explicit", output: "explicit" },
    }),
    schema,
  };
}
export const MODEL_DECISION_SCHEMA_ENTRIES = Object.freeze([
  schemaBinding(decisionEffectInputSchema, "effect_input"),
  schemaBinding(decisionResultSchema, "effect_output"),
]);
export const MODEL_DECISION_EFFECT = defineDurableEffect<
  DecisionEffectInput & Json,
  DecisionResult & Json
>({
  name: "model.decision",
  version: "1",
  retrySafety: { mode: "repeatable" },
  inputSchema: MODEL_DECISION_SCHEMA_ENTRIES[0].descriptor,
  outputSchema: MODEL_DECISION_SCHEMA_ENTRIES[1].descriptor,
});
