import type { StandardSchemaV1 } from "@standard-schema/spec";
import { defineEffect } from "@sweatpan.ts/core";
import type { Operation, Outcome } from "@standard-durability/core";

const invocationSchema: StandardSchemaV1<unknown, { key: string; sequence: number }> = {
  "~standard": {
    version: 1,
    vendor: "sweatpan.ts",
    validate(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        "key" in value &&
        typeof value.key === "string" &&
        value.key.trim().length > 0 &&
        "sequence" in value &&
        typeof value.sequence === "number" &&
        Number.isSafeInteger(value.sequence) &&
        value.sequence >= 0
      ) {
        return { value: { key: value.key, sequence: value.sequence } };
      }
      return { issues: [{ message: "Invalid record invocation" }] };
    },
  },
};

/** Internal ordinary effect; implementations are installed per acquired Guest. */
export const recordDefinition = defineEffect(
  { key: "$record", context: invocationSchema },
  function* (): Operation<Outcome<unknown, unknown>, never> {
    throw new Error("Record implementation is not installed");
  },
);
