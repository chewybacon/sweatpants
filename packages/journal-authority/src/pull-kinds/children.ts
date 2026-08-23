import { z } from "zod";
import { registerPullKind } from "./registry.ts";

const childRefSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().min(1),
  input: z.json(),
});

export const invokeDescriptorSchema = z.strictObject({
  kind: z.literal("invoke"),
  child: childRefSchema,
});

export const spawnDescriptorSchema = z.strictObject({
  kind: z.literal("spawn"),
  child: childRefSchema,
});

function childPolicy(kind: string, schema: z.ZodType): void {
  registerPullKind({
    kind,
    // The whole child family parks under the shared "child" reason.
    pendingReason: "child",
    descriptorSchema: schema,
    resolutionAuthority: (descriptor, audience) => ({
      kind: "child",
      mode: descriptor.kind as "invoke" | "spawn",
      audience,
      capability: "",
    }),
  });
}

childPolicy("invoke", invokeDescriptorSchema);
childPolicy("spawn", spawnDescriptorSchema);
