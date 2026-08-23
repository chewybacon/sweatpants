import { z } from "zod";
import type { DurableSampleDescriptor } from "@sweatpants/durable-execution";
import { parser, type Parser } from "@sweatpants/foundation";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { registerPullKind } from "./registry.ts";

export const sampleDescriptorSchema = z.strictObject({
  kind: z.literal("sample"),
  input: z.json(),
});

export const sampleDescriptorParser: Parser<DurableSampleDescriptor> = parser(
  sampleDescriptorSchema,
).map((descriptor): DurableSampleDescriptor => descriptor as unknown as DurableSampleDescriptor);

registerPullKind({
  kind: "sample",
  journalLabel: () => "model.sample",
  descriptorSchema: sampleDescriptorSchema,
  resolutionTarget: () => ({
    resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR,
    audience: "model-runtime",
  }),
  // Model-runtime sampling parks participant-style; the owning session's
  // sampling resolver settles it against the journaled canonical request.
  resolutionAuthority: (_descriptor, audience) => ({
    kind: "participant",
    audience,
    capability: "",
  }),
});
export type SampleDescriptor = DurableSampleDescriptor;
