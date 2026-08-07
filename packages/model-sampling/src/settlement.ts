import { assertJson } from "@sweatpants/foundation";
import type { ModelResponse } from "@sweatpants/model-provider";
import type { ModelResponseMode, ModelSampleOutput, ModelSampleResult } from "./contract.ts";
import { assistantText, assistantToolCalls } from "./provider.ts";

export { assistantText, assistantToolCalls } from "./provider.ts";

function settleJson(response: ModelResponse): ModelSampleOutput {
  const call = assistantToolCalls(response)[0];
  if (call) return { type: "json", value: call.input };
  const rawText = assistantText(response);
  try {
    return { type: "json", value: assertJson(JSON.parse(rawText)) };
  } catch {
    return {
      type: "json-invalid",
      error: { message: "Failed to parse structured sample", rawText },
    };
  }
}

/** Settles canonical provider output once before the durable effect result is journaled. */
export function settleModelSample(
  responseMode: ModelResponseMode,
  response: ModelResponse,
): ModelSampleResult {
  return {
    message: response,
    output: responseMode.type === "message" ? { type: "message" } : settleJson(response),
  };
}
