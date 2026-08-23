/** Shared wire primitives for pull-descriptor schemas. Leaf module. */
import { z } from "zod";

/** Wire shape of a portable schema reference inside descriptors. */
export const portableSchemaDescriptorSchema = z.strictObject({
  identity: z.string().min(1),
  role: z.string().min(1).max(128),
  version: z.string().min(1),
  vendor: z.string().min(1),
  inputProjection: z.json(),
  outputProjection: z.json(),
  fidelity: z.strictObject({
    input: z.enum(["lossless", "explicit"]),
    output: z.enum(["lossless", "explicit"]),
  }),
  digest: z.string().min(1),
});

/** Single source of truth for record key rules across authoring and wire boundaries. */
export const recordKeySchema = z
  .string()
  .min(1, "Record key must be non-empty")
  .refine((key) => new TextEncoder().encode(key).byteLength <= 128, {
    message: "Record key must be at most 128 UTF-8 bytes",
  });
