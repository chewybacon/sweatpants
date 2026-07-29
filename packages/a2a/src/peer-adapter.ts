import { CrankError } from "@sweatpants/durable-execution";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createPinnedDurableProgram } from "@sweatpants/durable-execution";
import { assertJson, canonicalJson, sha256 } from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import { foreignA2AAdapterChild } from "./foreign-adapter.ts";
import type { ForeignA2AStartRequest, ForeignA2ATerminalResult } from "./foreign-task-types.ts";
import { SWEATPANTS_PEER_PROFILE_URI, type PeerInvocationPin } from "./peer-types.ts";

export type PeerAdapterInput = {
  readonly pin: PeerInvocationPin;
  readonly request: ForeignA2AStartRequest;
};
const INPUT = portable("sweatpants.peer-adapter/input", "program_input");
const OUTPUT = portable("sweatpants.peer-adapter/output", "program_output");
export const PEER_ADAPTER_PROGRAM = Object.freeze({
  id: "sweatpants.callee-authoritative-peer-adapter",
  version: "1.0.0",
  digest: sha256(
    canonicalJson({
      domain: "sweatpants.peer-adapter.artifact.v1",
      foreignAdapter: "sweatpants.foreign-a2a-task-adapter@1.0.0",
      inputDigest: INPUT.digest,
      outputDigest: OUTPUT.digest,
    }),
  ),
});

export const peerTaskAdapter = createPinnedDurableProgram(
  {
    programId: PEER_ADAPTER_PROGRAM.id,
    version: PEER_ADAPTER_PROGRAM.version,
    digest: PEER_ADAPTER_PROGRAM.digest,
    inputSchema: INPUT,
    outputSchema: OUTPUT,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: false, structuredChildren: true, replay: "strict" },
  },
  function* (rawInput, context) {
    const input = rawInput as unknown as PeerAdapterInput;
    if (
      input.request.pin.invocationId !== input.pin.foreign.invocationId ||
      input.request.pin.cardDigest !== input.pin.foreign.cardDigest
    ) {
      throw new CrankError("peer_identity_mismatch", "Peer adapter input pin differs");
    }
    const result = yield* context.invoke<ForeignA2ATerminalResult>(
      foreignA2AAdapterChild(input.request),
    );
    verifyPeerResultEcho(result, input.pin);
    return result;
  },
);

export function peerAdapterChild(pin: PeerInvocationPin, request: ForeignA2AStartRequest) {
  return { ...PEER_ADAPTER_PROGRAM, input: { pin, request } };
}

export const PEER_ADAPTER_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  { descriptor: INPUT, schema: jsonSchema() },
  { descriptor: OUTPUT, schema: jsonSchema() },
]);

export function verifyPeerResultEcho(
  result: ForeignA2ATerminalResult,
  pin: PeerInvocationPin,
): void {
  const task = "task" in result ? result.task : undefined;
  if (!task) {
    return;
  }
  if (!task.metadata || typeof task.metadata !== "object" || Array.isArray(task.metadata)) {
    throw new CrankError("peer_grant_echo_mismatch", "Peer result omitted profile metadata");
  }
  const profile = task.metadata[SWEATPANTS_PEER_PROFILE_URI];
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    profile["grantSetDigest"] !== pin.grantSet.digest ||
    profile["requirementManifestDigest"] !== pin.requirementManifest.manifestDigest
  ) {
    throw new CrankError("peer_grant_echo_mismatch", "Peer result grant/manifest echo differs");
  }
}
function portable(
  identity: string,
  role: Parameters<typeof createPortableSchemaDescriptor>[0]["role"],
) {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1.0.0",
    vendor: "sweatpants-a2a",
    inputProjection: true,
    outputProjection: true,
    fidelity: { input: "explicit", output: "explicit" },
  });
}
function jsonSchema(): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants-a2a",
      validate(value: unknown) {
        try {
          return { value: assertJson(value) };
        } catch {
          return { issues: [{ message: "value must be canonical JSON" }] };
        }
      },
    },
  };
}
