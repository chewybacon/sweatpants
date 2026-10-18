import { omitUndefinedOptionals } from "@sweatpants/durable-execution/optional-fields";
import { z } from "zod";
import { registerPullKind } from "./registry.ts";
import { portableSchemaDescriptorSchema, recordKeySchema } from "./wire.ts";

export const elicitDescriptorSchema = omitUndefinedOptionals(
  z.strictObject({
    kind: z.literal("elicit"),
    key: recordKeySchema,
    message: z.string(),
    response: portableSchemaDescriptorSchema,
    contextContract: portableSchemaDescriptorSchema.optional(),
    context: z.json().optional(),
    binding: z.strictObject({ id: z.string().min(1) }).optional(),
  }),
);

registerPullKind({
  kind: "elicit",
  descriptorSchema: elicitDescriptorSchema,
  journalLabel: (descriptor) => `elicit(${(descriptor as { key: string }).key})`,
  resolutionAuthority: (_descriptor, audience) => ({
    kind: "participant",
    audience,
    capability: "",
  }),
});
