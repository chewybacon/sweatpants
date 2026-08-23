import { z } from "zod";
import type { DurableForeignDescriptor } from "@sweatpants/durable-execution";
import { CrankError } from "@sweatpants/durable-execution";
import { parser, type Parser } from "@sweatpants/foundation";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { registerPullKind } from "./registry.ts";

export const foreignDurabilitySchema = z.enum([
  "opaque",
  "ephemeral_handle",
  "resumable_handle",
  "server_task",
  "crank_native",
]);

export const foreignDescriptorSchema = z.strictObject({
  kind: z.literal("foreign"),
  driver: z.string().min(1),
  tool: z.string().min(1),
  input: z.json(),
  durability: foreignDurabilitySchema,
});

registerPullKind({
  kind: "foreign",
  journalLabel: (descriptor) => `foreign(${(descriptor as { tool: string }).tool})`,
  descriptorSchema: foreignDescriptorSchema,
  // Settled values are canonical Json: foreign tools carry no manifest.
  resolutionTarget: (descriptor) => {
    assertEphemeralForeign(descriptor as { durability: string });
    return {
      resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR,
      audience: `foreign:${(descriptor as { driver: string }).driver}`,
    };
  },
  // Session-bound: the owning session resolves against its live reference.
  resolutionAuthority: (_descriptor, audience) => ({
    kind: "participant",
    audience,
    capability: "",
  }),
});

/** Reserve-time gate: only ephemeral foreign calls are supported. */
export function assertEphemeralForeign(descriptor: { readonly durability: string }): void {
  if (descriptor.durability !== "ephemeral_handle") {
    throw new CrankError(
      "invalid_descriptor",
      "Only ephemeral foreign calls are supported; resumable modes fail closed",
    );
  }
}
export const foreignDescriptorParser: Parser<DurableForeignDescriptor> = parser(
  foreignDescriptorSchema,
).map((descriptor): DurableForeignDescriptor => descriptor as unknown as DurableForeignDescriptor);
export type ForeignDescriptor = DurableForeignDescriptor;
