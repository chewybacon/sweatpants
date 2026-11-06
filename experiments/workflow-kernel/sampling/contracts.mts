import { z } from "zod";
import { defineEffect } from "../../../packages/v2/core/src/index.ts";

// Text-only experiment. No inherited transcript, provider IDs, credentials, tools,
// arbitrary generation options or schemas cross this authoring boundary.
export const sampleRequest = z.strictObject({
  prompt: z.string().min(1).max(8192),
  systemPrompt: z.string().max(4096).optional(),
  history: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(8192) }))
    .max(16)
    .optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});
export const sampleResponse = z.strictObject({
  text: z.string(),
  model: z.strictObject({ id: z.string(), provider: z.string(), api: z.string() }),
  responseId: z.string().nullable(),
});
export type SampleRequest = z.infer<typeof sampleRequest>;
export type SampleResponse = z.infer<typeof sampleResponse>;
export const sample = defineEffect({
  key: "experiment.text-sample/1",
  context: sampleRequest,
  response: sampleResponse,
});
export const moveRequest = z.strictObject({ message: z.string().min(1).max(1024) });
export const moveResponse = z.enum(["rock", "paper", "scissors"]);
export const move = defineEffect({
  key: "experiment.rps-move/1",
  context: moveRequest,
  response: moveResponse,
});
// Registered, portable schema; arbitrary guest-supplied validators are not supported.
export const movePlan = z.strictObject({ move: moveResponse, reason: z.string().min(1).max(160) });
export const structuredResponse = z.discriminatedUnion("valid", [
  z.strictObject({ valid: z.literal(true), value: movePlan, sample: sampleResponse }),
  z.strictObject({
    valid: z.literal(false),
    reason: z.enum(["invalid-json", "schema-mismatch"]),
    sample: sampleResponse,
  }),
]);
export const sampleSchema = defineEffect({
  key: "experiment.move-plan-sample/1",
  context: sampleRequest,
  response: structuredResponse,
});
export const schemas = {
  sample: { input: sampleRequest, output: sampleResponse },
  sampleSchema: { input: sampleRequest, output: structuredResponse },
  elicit: { input: moveRequest, output: moveResponse },
};
export const declarations = { sample, sampleSchema, elicit: move };
export const prompt =
  "Choose exactly one move for rock-paper-scissors. Reply with only rock, paper, or scissors. Round ";
