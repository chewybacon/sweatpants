import { z } from "zod";
import type { Json } from "@sweatpan.ts/providers";
const jsonValue: z.ZodType<Json> = z.json();

export const legacyCodeToolId = "yo-chat-v2/lua-tool-v1";
export const codeToolId = "yo-chat-v2/lua-tool-v2";
export const codeInput = z
  .object({
    source: z.string().min(1).max(48000),
    input: jsonValue.optional(),
    validateOnly: z.boolean().optional(),
  })
  .strict();
export const codeResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: jsonValue }),
  z.object({ status: z.literal("valid"), checked: z.array(z.string()) }),
  z.object({ status: z.literal("invalid"), diagnostics: z.array(z.string()) }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);
export type CodeResult = z.infer<typeof codeResult>;
