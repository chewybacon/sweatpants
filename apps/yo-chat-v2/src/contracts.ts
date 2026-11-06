import { z } from "zod";
import { supportSchema, selectionSchema } from "./elicit-support.ts";
import { codeResult } from "./code-contracts.ts";
import { flightOption, flightId, seatId, flightResult } from "./flight.ts";

const target = z.object({
  root: z.string(),
  execution: z.string(),
  parentExecution: z.string().optional(),
  grant: z.object({ requestId: z.string(), resolutionId: z.string() }),
});
export const questionSchema = z.discriminatedUnion("kind", [
  target.extend({
    kind: z.literal("pickFlight"),
    input: z.object({ destination: z.string(), flights: z.array(flightOption) }),
    selection: selectionSchema,
  }),
  target.extend({
    kind: z.literal("pickSeat"),
    input: z.object({ flight: z.string(), seats: z.array(z.string()) }),
    selection: selectionSchema,
  }),
]);
export type Question = z.infer<typeof questionSchema>;
export const answerSchema = z.discriminatedUnion("kind", [
  target.extend({ kind: z.literal("pickFlight"), value: flightId }),
  target.extend({ kind: z.literal("pickSeat"), value: seatId }),
]);
export type Answer = z.infer<typeof answerSchema>;
export const answerReceiptSchema = z.object({ receipt: z.string(), duplicate: z.boolean() });
export type AnswerReceipt = z.infer<typeof answerReceiptSchema>;

export const submission = z
  .object({
    command: z.string().min(1).max(200),
    prompt: z.string().trim().min(1).max(16000),
    after: z.string().nullable(),
    support: z.array(supportSchema).max(16).optional(),
    mode: z.enum(["tools", "code"]).optional(),
  })
  .strict();
export type Submission = z.infer<typeof submission>;
export const codeRunSchema = z.object({
  id: z.string(),
  source: z.string(),
  state: z.enum(["running", "completed", "cancelled"]),
  result: codeResult.optional(),
});
const message = z.object({
  type: z.literal("message"),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        id: z.string(),
        text: z.string(),
        state: z.enum(["provisional", "complete"]),
      }),
      z.object({
        type: z.literal("code-run"),
        id: z.string(),
        run: codeRunSchema,
        questions: z.array(questionSchema),
      }),
      z.object({ type: z.literal("question"), id: z.string(), question: questionSchema }),
      z.object({ type: z.literal("flight-selection"), id: z.string(), selection: flightResult }),
    ]),
  ),
});
export const viewSchema = z.object({
  messages: z.array(message),
  latest: z.string().nullable(),
  status: z.enum(["empty", "running", "completed", "cancelled"]),
  active: z.boolean(),
  questions: z.array(questionSchema).default([]),
});
export type View = z.infer<typeof viewSchema>;
export const receiptSchema = z.object({
  execution: z.string(),
  ordinal: z.number(),
  duplicate: z.boolean(),
});
export type Receipt = z.infer<typeof receiptSchema>;

/** This payload applies only to the submitted tuple, not to previous uses of its ID. */
export const rejectionSchema = z.object({
  kind: z.literal("not-admitted"),
  command: z.string(),
  code: z.enum(["stale-predecessor", "predecessor-incomplete", "command-conflict"]),
});
export type RejectionCode = z.infer<typeof rejectionSchema>["code"];
export class SubmissionRejected extends Error {
  constructor(readonly code: RejectionCode) {
    super(`Submission not admitted: ${code}`);
  }
}
