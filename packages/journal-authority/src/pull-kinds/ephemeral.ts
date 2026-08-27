import { z } from "zod";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  CrankError,
  type DurableEphemeralDescriptor,
  type LegacyForeignDescriptor,
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

/** Forever dual-read schema for journals written before REQ-076. */
export const legacyForeignDescriptorSchema = z.strictObject({
  kind: z.literal("foreign"),
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

registerPullKind({
  kind: "foreign",
  journalLabel: (descriptor) => `foreign(${(descriptor as { tool: string }).tool})`,
  descriptorSchema: legacyForeignDescriptorSchema,
  pendingReason: "ephemeral",
  resolutionTarget: (descriptor) => {
    assertEphemeralDescriptor(descriptor as { durability: string });
    return {
      resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR,
      // Historical audience identity remains byte-for-byte stable.
      audience: `foreign:${(descriptor as { driver: string }).driver}`,
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
      "Only ephemeral calls are supported; resumable modes fail closed",
    );
  }
}

export const ephemeralDescriptorParser: Parser<DurableEphemeralDescriptor> = parser(
  ephemeralDescriptorSchema,
).map((descriptor): DurableEphemeralDescriptor => descriptor as DurableEphemeralDescriptor);

export const legacyForeignDescriptorParser: Parser<LegacyForeignDescriptor> = parser(
  legacyForeignDescriptorSchema,
).map((descriptor): LegacyForeignDescriptor => descriptor as LegacyForeignDescriptor);

export type EphemeralDescriptor = DurableEphemeralDescriptor;
