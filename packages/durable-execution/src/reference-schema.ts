import { z } from "zod";
import { omitUndefinedOptionals } from "./omit-undefined-optionals.ts";

const nonemptySchema = z.string().min(1).max(4_096);

export const durableReferenceSchema = omitUndefinedOptionals(
  z.strictObject({
    id: nonemptySchema,
    byteLength: z.number().int().nonnegative().safe().optional(),
    version: z.string().min(1).max(256).optional(),
    integrity: z.strictObject({ algorithm: nonemptySchema, value: nonemptySchema }).optional(),
  }),
);
