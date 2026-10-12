import { createDurableTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import {
  samplingDescription,
  samplingIdentity,
  samplingParameters,
  samplingOutput,
  sampleText,
} from "../sampling.ts";

export const sample = createDurableTool("sample")
  .description(samplingDescription)
  .identity({ version: "0.0.1", digest: sha256(samplingIdentity) })
  .parameters(samplingParameters)
  .output(samplingOutput)
  .samples()
  .execute(function* (input, context) {
    return yield* sampleText(input, context);
  });
