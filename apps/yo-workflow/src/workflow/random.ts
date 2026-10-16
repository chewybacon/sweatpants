import { assertJson, canonicalJson, sha256 } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import { Eval, type TisynExpr } from "@tisyn/ir";
import { z } from "zod";
import { expandConstructors } from "./constructor-syntax.ts";

export const randomParameters = z.union([
  z
    .object({
      choices: z.array(z.string().min(1).max(200)).min(1).max(64),
    })
    .strict(),
  z
    .object({
      min: z.number().int().min(-2_147_483_648).max(2_147_483_647),
      max: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    })
    .strict(),
]);

export const randomContract = {
  name: "random",
  description:
    "Choose uniformly from choices, a nonempty array of distinct string labels, and return the chosen label directly. Alternatively supply min and max for a uniform integer with inclusive signed 32-bit bounds and min <= max. Supply exactly one form. Each executed call records the returned value: replay returns that accepted value without drawing again. Use for chance; Sample generates language and Classify interprets meaning.",
  parameters: assertJson(z.toJSONSchema(randomParameters)),
  output: { anyOf: [{ type: "string" }, { type: "integer" }] },
};

export function expandRandomSyntax(source: string): string {
  return expandConstructors(source, { Random: "__tisyn_random" });
}

export function lowerRandomSyntax(value: TisynExpr): TisynExpr {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(lowerRandomSyntax);
  const node = value as Record<string, TisynExpr>;
  if (node.tisyn === "eval" && node.id === "__tisyn_random") {
    if (!Array.isArray(node.data) || node.data.length !== 1) {
      throw new Error("Random requires one request expression");
    }
    return Eval("random", lowerRandomSyntax(node.data[0])) as TisynExpr;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, lowerRandomSyntax(child)]),
  );
}

export function* randomValue(
  input: z.infer<typeof randomParameters>,
  context: DurableProgramContext,
) {
  const request = randomParameters.parse(input);
  if ("choices" in request) {
    if (new Set(request.choices).size !== request.choices.length) {
      throw new Error("Random choices must be distinct labels");
    }
  } else if (request.min > request.max) {
    throw new Error("Random requires min <= max");
  }
  const width = "choices" in request ? request.choices.length : request.max - request.min + 1;
  // Bind replay to the complete request, including choice order, without an unbounded key.
  return yield* context.record(
    {
      key: `tisyn.random/v2:${sha256(canonicalJson(request))}`,
      retrySafety: { mode: "repeatable" },
    },
    function* () {
      const limit = Math.floor(0x1_0000_0000 / width) * width;
      const word = new Uint32Array(1);
      // Reject the incomplete bucket to avoid modulo bias.
      do {
        crypto.getRandomValues(word);
      } while (word[0] >= limit);
      const index = word[0] % width;
      return "choices" in request ? request.choices[index] : request.min + index;
    },
  );
}
