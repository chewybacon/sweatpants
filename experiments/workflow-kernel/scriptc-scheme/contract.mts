import { z } from "zod";
import type { Operation } from "effection";
import type { Outcome } from "../../../packages/v2/execution/src/index.ts";
import { defineEffect } from "../../../packages/v2/core/src/index.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Assembly-owned declarations: the compiler consumes the same effect identities
// and schemas as hosting. It neither invokes their call builders nor grants them.
export const requestSchema = z.object({ message: z.string() });
export const replySchema = z.string();
export const effects = {
  approval: defineEffect({
    key: "scriptc.review.approval",
    context: requestSchema,
    response: replySchema,
  }),
  cleanup: defineEffect({
    key: "scriptc.review.cleanup",
    context: requestSchema,
    response: replySchema,
  }),
};

// Only the explicitly named Value conveniences unwrap Outcomes in compiled IR.
// The capability boundary itself matches ToolContext: Outcomes arrive as data.
// The compiler owns these expansions. Authored modules cannot extend this table.
export const macroBindings = {
  elicit: ["approval"],
  effect: ["cleanup"],
  elicitValue: ["approval"],
  effectValue: ["cleanup"],
} as const;

export type WorkflowContext = {
  [M in keyof typeof macroBindings]: <K extends (typeof macroBindings)[M][number]>(
    key: K,
    request: StandardSchemaV1.InferInput<(typeof effects)[K]["context"]>,
  ) => Operation<
    M extends "elicitValue" | "effectValue"
      ? StandardSchemaV1.InferOutput<NonNullable<(typeof effects)[K]["response"]>>
      : Outcome<StandardSchemaV1.InferOutput<NonNullable<(typeof effects)[K]["response"]>>, string>
  >;
};
