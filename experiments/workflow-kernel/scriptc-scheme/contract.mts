import { z } from "zod";
import type { Operation } from "effection";
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

// This experimental authoring adapter returns successful values directly;
// failures enter the kernel's throw/cleanup path. It is not ToolContext's Outcome API.
// The compiler owns these expansions. Authored modules cannot extend this table.
export const macroBindings = {
  elicit: ["approval"],
  effect: ["cleanup"],
} as const;

export type WorkflowContext = {
  [M in keyof typeof macroBindings]: <K extends (typeof macroBindings)[M][number]>(
    key: K,
    request: StandardSchemaV1.InferInput<(typeof effects)[K]["context"]>,
  ) => Operation<StandardSchemaV1.InferOutput<NonNullable<(typeof effects)[K]["response"]>>>;
};
