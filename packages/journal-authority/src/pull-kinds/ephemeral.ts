import { z } from "zod";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  CrankError,
  type DurableEphemeralDescriptor,
} from "@sweatpants/durable-execution";
import { parser, type Parser } from "@sweatpants/foundation";
import { registerPullKind } from "./registry.ts";

export const ephemeralDurabilitySchema = z.enum([
  "opaque",
  "ephemeral_handle",
  "resumable_handle",
  "server_task",
  "crank_native",
]);

export const ephemeralDescriptorSchema = z.strictObject({
  kind: z.literal("ephemeral"),
  driver: z.string().min(1),
  tool: z.string().min(1),
  input: z.json(),
  durability: ephemeralDurabilitySchema,
});

registerPullKind({
  kind: "ephemeral",
  journalLabel: (descriptor) => `ephemeral(${(descriptor as { tool: string }).tool})`,
  descriptorSchema: ephemeralDescriptorSchema,
  pendingReason: "ephemeral",
  resolutionTarget: (descriptor) => {
    assertEphemeralDescriptor(descriptor as { durability: string });
    return {
      resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR,
      audience: `ephemeral:${(descriptor as { driver: string }).driver}`,
    };
  },
  resolutionAuthority: (_descriptor, audience) => ({
    kind: "participant",
    audience,
    capability: "",
  }),
});

/** Only process-bound handles satisfy the ephemeral interaction contract. */
export function assertEphemeralDescriptor(descriptor: { readonly durability: string }): void {
  if (descriptor.durability !== "ephemeral_handle") {
    throw new CrankError(
      "invalid_descriptor",
      "Only process-bound ephemeral_handle calls resolve here",
    );
  }
}

export const ephemeralDescriptorParser: Parser<DurableEphemeralDescriptor> = parser(
  ephemeralDescriptorSchema,
).map((descriptor): DurableEphemeralDescriptor => descriptor as DurableEphemeralDescriptor);

export type EphemeralDescriptor = DurableEphemeralDescriptor;
