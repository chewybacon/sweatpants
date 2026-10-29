import { defineEffect } from "@sweatpan.ts/core";
import type { Operation, Outcome } from "@standard-durability/core";

/** Internal ordinary effect; implementations are installed per acquired Guest. */
export const recordDefinition = defineEffect(
  {
    key: "$record",
    context: {
      "~standard": {
        version: 1,
        vendor: "sweatpan.ts",
        validate(value: unknown) {
          return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
            ? { value }
            : { issues: [{ message: "Invalid record invocation" }] };
        },
      },
    },
  },
  function* (): Operation<Outcome<unknown, unknown>, never> {
    throw new Error("Record implementation is not installed");
  },
);
