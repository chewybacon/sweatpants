import { z } from "zod";
import { CrankError, type DurableSampleDescriptor } from "@sweatpants/durable-execution";
import { parser, type Parser } from "@sweatpants/foundation";
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
  resolutionTarget: (_descriptor, manifest) => {
    const declaration = manifest.pulls?.["sample"];
    if (!declaration) {
      throw new CrankError(
        "invalid_descriptor",
        "Program manifest does not declare the sample pull contract",
      );
    }
    return {
      resultDescriptor: declaration.output,
      inputDigest: declaration.input.digest,
      audience: "model-runtime",
    };
  },
  // Model-runtime sampling parks participant-style; the owning session's
  // sampling resolver settles it against the journaled canonical request.
  resolutionAuthority: (_descriptor, audience) => ({
    kind: "participant",
    audience,
    capability: "",
  }),
});
export type SampleDescriptor = DurableSampleDescriptor;
