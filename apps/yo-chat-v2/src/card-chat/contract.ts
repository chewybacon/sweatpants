import { z } from "zod";

import { playingCard, selectionInput } from "../cards/contracts.ts";
export { playingCard, selectionInput, type PlayingCard } from "../cards/contracts.ts";
const grant = z.object({ requestId: z.string(), resolutionId: z.string() });
export const chatCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    command: z.string().uuid(),
    prompt: z.string().trim().min(1).max(8000),
    after: z.string().nullable(),
  }),
  z.object({
    type: z.literal("answer"),
    root: z.string(),
    execution: z.string(),
    grant,
    value: playingCard,
  }),
  z.object({ type: z.literal("continue"), root: z.string() }),
]);
export type ChatCommand = z.infer<typeof chatCommand>;
export const questionView = z.object({
  id: z.string(),
  execution: z.string(),
  root: z.string(),
  input: selectionInput,
  state: z.enum(["open", "answered", "blocked", "cancelled"]),
  value: playingCard.optional(),
  grant: grant.optional(),
});
export type CardQuestion = z.infer<typeof questionView>;
export const chatView = z.object({
  thread: z.string(),
  latest: z.string().nullable(),
  turns: z.array(
    z.object({
      execution: z.string(),
      prompt: z.string(),
      status: z.enum(["running", "completed", "cancelled"]),
      parts: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), id: z.string(), text: z.string() }),
          z.object({
            type: z.literal("tool"),
            id: z.string(),
            name: z.string(),
            status: z.string(),
            questions: z.array(questionView),
            result: z.string().optional(),
          }),
        ]),
      ),
    }),
  ),
});
export type ChatView = z.infer<typeof chatView>;
