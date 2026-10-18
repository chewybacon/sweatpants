import { omitUndefinedOptionals } from "@sweatpants/durable-execution/optional-fields";
import { z } from "zod";
import type { Json } from "@sweatpants/foundation";
import { registerPullKind } from "./registry.ts";

const childDurabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("crank_native") }),
  z.strictObject({
    kind: z.literal("peer_hosted"),
    peer: z.string().min(1),
    sampling: z.enum(["delegated", "private"]),
  }),
]);

const childRefSchema = omitUndefinedOptionals(
  z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().min(1),
    input: z.json(),
    durability: childDurabilitySchema.optional(),
  }),
);

export const invokeDescriptorSchema = z.strictObject({
  kind: z.literal("invoke"),
  child: childRefSchema,
});

export const spawnDescriptorSchema = z.strictObject({
  kind: z.literal("spawn"),
  child: childRefSchema,
});

/** REQ-030: every fork descriptor carries an explicit or inherited expiry
 *  policy; admission fails closed when no effective deadline resolves. */
export const forkExpirySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at"), atMs: z.number() }),
  z.strictObject({ kind: z.literal("after"), durationMs: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("inherit") }),
]);

/** REQ-025: the closed fork-policy union at the wire. Supervision is a
 *  literal paired to the mode, so incompatible pairs fail schema admission
 *  before any member row exists. */
export const allDescriptorSchema = z.strictObject({
  kind: z.literal("all"),
  supervision: z.literal("one_for_all"),
  children: z.array(childRefSchema).min(1),
  expiry: forkExpirySchema,
});

export const raceDescriptorSchema = z.strictObject({
  kind: z.literal("race"),
  supervision: z.literal("first_success"),
  children: z.array(childRefSchema).min(1),
  expiry: forkExpirySchema,
});

type ChildMode = "invoke" | "all" | "race" | "spawn";

function childPolicy(
  kind: ChildMode,
  schema: z.ZodType,
  label: (descriptor: Json) => string,
): void {
  registerPullKind({
    kind,
    // The whole child family parks under the shared "child" reason.
    pendingReason: "child",
    descriptorSchema: schema,
    journalLabel: label,
    resolutionAuthority: (descriptor, audience) => ({
      kind: "child",
      mode: descriptor.kind as ChildMode,
      audience,
      capability: "",
    }),
  });
}

childPolicy(
  "invoke",
  invokeDescriptorSchema,
  (descriptor) => `invoke(${(descriptor as z.infer<typeof invokeDescriptorSchema>).child.id})`,
);
childPolicy(
  "spawn",
  spawnDescriptorSchema,
  (descriptor) => `spawn(${(descriptor as z.infer<typeof spawnDescriptorSchema>).child.id})`,
);
childPolicy(
  "all",
  allDescriptorSchema,
  (descriptor) => `all(${(descriptor as z.infer<typeof allDescriptorSchema>).children.length})`,
);
childPolicy(
  "race",
  raceDescriptorSchema,
  (descriptor) => `race(${(descriptor as z.infer<typeof raceDescriptorSchema>).children.length})`,
);
