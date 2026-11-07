import { createHash } from "node:crypto";
import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";
import { admitLinkedCaller } from "../scriptc-scheme/linked.mjs";
import { declarations, samplingProfile, validateSamplingRequest } from "./contracts.mts";
import type { SampleModel } from "./provider.mts";

/** Experiment-only built-ins, registered by the host, not macros supplied by a model. */
export function bindSamplingProgram(caller: string, identity: string, model: SampleModel) {
  const source = `(registered-program () ((sample host) (sampleSchema host) (elicit host)) (${admitLinkedCaller(caller)}))`;
  const program =
    "sampling-scheme/1:" +
    createHash("sha256")
      .update(JSON.stringify({ source, identity, model, profile: samplingProfile }))
      .digest("hex");
  return {
    source,
    program,
    model: { ...model },
    decodeRequest(boundary: { site: string; value: unknown }): CapabilityRequest {
      const value = boundary.value;
      if (
        !Object.hasOwn(declarations, boundary.site) ||
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== "effect" ||
        value[1] !== boundary.site ||
        value[2] !== "1"
      ) {
        throw new Error("Unregistered sampling exchange");
      }
      const definition = declarations[boundary.site as keyof typeof declarations];
      // Host grants validate schemas before delivery too. Reject malformed sandbox
      // requests here before admission; no provider call or extra authority follows.
      return validateSamplingRequest({ effect: definition.id, input: value[3] });
    },
  };
}
