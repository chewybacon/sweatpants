import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Parser } from "@sweatpants/foundation";
import {
  modelContextParser,
  modelResponseParser,
} from "../../packages/model-provider/src/model.ts";
import { z } from "zod";
import { defineApi, operation } from "./api-definition.ts";

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

/** Model selection, credentials and streaming resources belong to the host scope. */
export const ModelDefinition = defineApi("sweatpants.model", {
  sample: operation({
    version: "1",
    retrySafety: "repeatable",
    input: schema(modelContextParser),
    success: schema(modelResponseParser),
    failure: z.strictObject({ code: z.literal("model-error"), message: z.string() }),
  }),
});
