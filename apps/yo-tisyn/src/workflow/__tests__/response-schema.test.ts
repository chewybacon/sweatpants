import { expect, it } from "vitest";
import { z } from "zod";
import { responseSchema } from "../response-schema.ts";
import { exchangeMessages, projectExchange } from "../exchanges.ts";
import { createStructuredSampleExchange } from "@sweatpants/agent-sdk";

it("compiles a portable strict response contract and validates its bounds", () => {
  const schema = responseSchema({
    type: "object",
    properties: {
      kind: { enum: ["revise", "clarify"] },
      amount: { type: "integer", minimum: 0, maximum: 4 },
    },
    required: ["kind", "amount"],
    additionalProperties: false,
  });
  expect(schema.safeParse({ kind: "revise", amount: 2 }).success).toBe(true);
  expect(schema.safeParse({ kind: "revise", amount: 5 }).success).toBe(false);
  expect(schema.safeParse({ kind: "revise", amount: 2, extra: true }).success).toBe(false);
  expect(z.toJSONSchema(schema)).toMatchObject({
    type: "object",
    required: ["kind", "amount"],
    additionalProperties: false,
  });
});

it("rejects unsupported or malformed contracts before any sampling", () => {
  expect(() => responseSchema({ type: "string", pattern: "x" })).toThrow();
  expect(() => responseSchema({ type: "object", required: ["missing"] })).toThrow("declared");
  expect(() => responseSchema({ maximum: 3 })).toThrow("explicit number");
  expect(() => responseSchema({ anyOf: [] })).toThrow();
});

it("preserves a valid null structured exchange and rejects duplicated history identities", () => {
  const exchange = projectExchange(createStructuredSampleExchange("Return null", null, "sample-1"));
  expect(exchangeMessages([exchange])).toHaveLength(3);
  expect(() => exchangeMessages([exchange, exchange])).toThrow("Duplicate");
  expect(() => exchangeMessages([{ messages: exchange.messages.slice(0, 2) }])).toThrow(
    "unresolved",
  );
});
