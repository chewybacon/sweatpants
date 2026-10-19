import { z } from "zod";
import type { ExecutionInspection, InspectedValue } from "@sweatpants/workflow-kernel";

const valueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("display"), text: z.string(), truncated: z.boolean() }),
  z.object({ kind: z.literal("closure"), name: z.string(), environmentId: z.string() }),
  z.object({ kind: z.literal("callable"), name: z.string() }),
]);
const completionSchema = z.union([
  z.object({ kind: z.enum(["normal", "return", "throw"]), value: valueSchema }),
  z.object({ kind: z.enum(["break", "continue", "cancel"]) }),
]);

export const executionInspectionSchema = z.object({
  boundary: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("suspended"),
      request: z.object({ site: z.string(), request: z.json() }),
    }),
    z.object({ kind: z.literal("completed"), value: z.json() }),
    z.object({ kind: z.literal("failed"), error: z.json() }),
    z.object({ kind: z.literal("cancelled"), reason: z.string().optional() }),
  ]),
  calls: z.array(z.object({ id: z.string(), name: z.string() })),
  environments: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable(),
      bindings: z.array(z.object({ name: z.string(), value: valueSchema })),
    }),
  ),
  unwind: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("scope"),
        label: z.string(),
        pendingCleanup: z.array(valueSchema),
      }),
      z.object({
        kind: z.literal("cleanup"),
        remaining: z.array(valueSchema),
        completion: completionSchema,
      }),
      z.object({ kind: z.literal("finally"), completion: completionSchema }),
    ]),
  ),
  truncated: z.boolean(),
}) satisfies z.ZodType<ExecutionInspection>;

export function displayInspectedValue(value: InspectedValue): string {
  switch (value.kind) {
    case "display":
      return value.text + (value.truncated ? "…" : "");
    case "closure":
      return `${value.name} → environment ${value.environmentId}`;
    case "callable":
      return value.name;
  }
}
