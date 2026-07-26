import {
  DurableProgramCancellation,
  PullApplicationError,
  assertJson,
  canonicalJson,
  createPinnedDurableProgram,
  createPortableSchemaDescriptor,
  sha256,
  type DurableSchemaRegistryEntry,
  type DurableTool,
  type StandardSchemaV1,
} from "@sweatpants/session-contract";
import { peerContractAsEffectDefinition } from "./peer-contracts.ts";
import type {
  PeerEffectContract,
  PeerGrant,
  PeerResolverInput,
  PeerResolverOutput,
} from "./peer-types.ts";

export const PEER_RESOLVER_PROTOCOL_VERSION = 1 as const;
export const PEER_RESOLVER_BASE_CODE_DIGEST = sha256(
  "sweatpants.peer.single-effect-resolver.base-code.v1",
);
const INPUT = portable("sweatpants.peer-resolver/input", "program_input");
const OUTPUT = portable("sweatpants.peer-resolver/output", "program_output");

export type PeerResolverBundle = {
  readonly grant: PeerGrant;
  readonly contract: PeerEffectContract;
  readonly tool: DurableTool<PeerResolverInput, PeerResolverOutput>;
  readonly schemaEntries: DurableSchemaRegistryEntry[];
};

/** Compiles one exact granted contract into one replay-pinned local resolver program. */
export function compilePeerResolverBundle(grant: PeerGrant): PeerResolverBundle {
  if (grant.route !== "caller") {
    throw new Error("Only caller-routed grants compile local resolver bundles");
  }
  const definition = peerContractAsEffectDefinition(grant.contract);
  const digest = sha256(
    canonicalJson({
      domain: "sweatpants.peer.resolver-bundle.v1",
      baseCodeDigest: PEER_RESOLVER_BASE_CODE_DIGEST,
      contractDigest: grant.contract.contractDigest,
      protocolVersion: PEER_RESOLVER_PROTOCOL_VERSION,
    }),
  );
  const tool = createPinnedDurableProgram<PeerResolverInput, PeerResolverOutput>(
    {
      programId: `sweatpants.peer-resolver.${grant.contract.name}`,
      version: `1.0.0+${grant.contract.contractDigest.slice(0, 12)}`,
      digest,
      inputSchema: INPUT,
      outputSchema: OUTPUT,
      elicits: {},
      effects: { [definition.name]: definition },
      capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
    },
    function* (input, context) {
      if (
        input.grantId !== grant.grantId ||
        input.grantVersion !== grant.grantVersion ||
        input.invocationId !== grant.invocationId
      ) {
        throw new Error("Peer resolver input does not match its pinned grant");
      }
      try {
        const value = yield* context.effect(definition, input.input, {
          audience: `peer:${grant.calleeIdentity}`,
          route: `grant:${grant.grantId}:${grant.grantVersion}`,
        });
        return { status: "ok", value };
      } catch (error) {
        if (error instanceof DurableProgramCancellation) {
          return { status: "cancelled" };
        }
        if (error instanceof PullApplicationError) {
          return { status: "error", error: error.applicationError };
        }
        throw error;
      }
    },
  );
  return Object.freeze({
    grant,
    contract: grant.contract,
    tool,
    schemaEntries: [
      { descriptor: INPUT, schema: jsonSchema() },
      { descriptor: OUTPUT, schema: jsonSchema() },
    ],
  });
}

export function peerResolverTaskId(peerTaskId: string, remoteEffectId: string): string {
  return `peer-resolver_${sha256(
    canonicalJson({
      domain: "sweatpants.peer.resolver-task.v1",
      peerTaskId,
      remoteEffectId,
    }),
  ).slice(0, 40)}`;
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
