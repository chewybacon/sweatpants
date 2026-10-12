import type { Operation } from "effection";
import { toPortableSchema } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const samplingDescription =
  "Request a model completion and return {text}. Supply instructions and all relevant context in prompt; this call does not inherit conversation history or previous samples. An optional systemPrompt sets instructions for this completion. No tools are exposed to this completion. maxTokens defaults to 1024 and is capped at 4096.";
export const samplingParameters = z.object({
  prompt: z.string().min(1).max(32_768),
  systemPrompt: z.string().max(8192).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});
export const samplingOutput = z.object({ text: z.string() });
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
  elicits: {},
};
export const samplingIdentity = "yo-tisyn.sample@0.0.1:durable-text";
export interface SamplingContext {
  sample(request: {
    prompt: string;
    systemPrompt?: string;
    maxTokens: number;
  }): Operation<{ text: string }>;
}

export function* sampleText(input: z.infer<typeof samplingParameters>, context: SamplingContext) {
  const result = yield* context.sample({
    prompt: input.prompt,
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    maxTokens: input.maxTokens ?? 1024,
  });
  return { text: result.text };
}
