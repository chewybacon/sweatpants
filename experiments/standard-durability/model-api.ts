import type { StandardSchemaV1 } from "@standard-schema/spec";
import { failure, success, type Parser } from "@sweatpants/foundation";
import {
  modelContextParser,
  modelResponseParser,
  decodeModelResponse,
  type ModelResponse,
} from "../../packages/model-provider/src/model.ts";
import { z } from "zod";
import { defineApi, operation, type OutcomeOf } from "./api-definition.ts";

/** Reuse the model contract's validation; the API binding rejects normalization on the wire. */
function schema<T>(parser: Parser<T>): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants-model",
      validate(value) {
        const result = parser.parse(value);
        return result.ok ? { value: result.value } : { issues: result.issues };
      },
    },
  };
}

/** The success branch cannot carry a second, contradictory failure channel. */
export type ModelSuccess = Omit<ModelResponse, "errorMessage"> & { readonly errorMessage: null };
const modelSuccessParser: Parser<ModelSuccess> = modelResponseParser.andThen((value) => {
  if (
    value.errorMessage !== null ||
    value.stopReason === "error" ||
    value.stopReason === "aborted"
  ) {
    return failure({ path: [], message: "Expected a successful model response" });
  }
  return success({ ...value, errorMessage: null });
});

/** Model selection, credentials and streaming resources belong to the host scope. */
export const ModelDefinition = defineApi("sweatpants.model", {
  sample: operation({
    version: "2",
    retrySafety: "repeatable",
    input: schema(modelContextParser),
    success: schema(modelSuccessParser),
    failure: z.strictObject({ code: z.literal("model-error"), message: z.string() }),
  }),
});

/** Adapt a completed native response. Never catch native failures or cancellation here. */
export function modelOutcome(
  response: ModelResponse,
): OutcomeOf<typeof ModelDefinition.operations.sample> {
  const value = decodeModelResponse(response);
  if (value.stopReason === "aborted") {
    throw new Error("Model sample aborted");
  }
  if (value.errorMessage !== null || value.stopReason === "error") {
    return {
      ok: false,
      error: { code: "model-error", message: value.errorMessage ?? "Model provider failed" },
    };
  }
  return { ok: true, value: { ...value, errorMessage: null } };
}
