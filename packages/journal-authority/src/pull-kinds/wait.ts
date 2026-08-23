import { z } from "zod";
import { registerPullKind } from "./registry.ts";
import { recordKeySchema } from "./wire.ts";

export const waitDescriptorSchema = z.strictObject({
  kind: z.literal("wait"),
  key: recordKeySchema,
  notBefore: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
});

registerPullKind({
  kind: "wait",
  descriptorSchema: waitDescriptorSchema,
  resolutionAuthority: (descriptor, audience) => ({
    kind: "clock",
    audience,
    notBefore: descriptor.kind === "wait" ? (descriptor.notBefore ?? "") : "",
    capability: "",
  }),
});
