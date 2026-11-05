import { z } from "zod";
export const submission = z
  .object({
    command: z.string().min(1).max(200),
    prompt: z.string().trim().min(1).max(16000),
    after: z.string().nullable(),
  })
  .strict();
export type Submission = z.infer<typeof submission>;
const message = z.object({
  type: z.literal("message"),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.object({ type: z.literal("text"), id: z.string(), text: z.string() })),
});
export const viewSchema = z.object({
  messages: z.array(message),
  latest: z.string().nullable(),
  status: z.enum(["empty", "running", "completed", "cancelled"]),
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
