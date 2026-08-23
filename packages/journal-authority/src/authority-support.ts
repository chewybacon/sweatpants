import { pullKindPolicy } from "./pull-kinds/index.ts";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  CrankError,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
  type DurableOperationDescriptor,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import type { EffectDefinition, OperationOutcome } from "@sweatpants/durable-effects";
import { canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { parser } from "@sweatpants/foundation/parser";
import { z } from "zod";

import type { SemanticEmissionPolicy } from "./authority-snapshot.ts";
import type { RestoreTicketClaims } from "./authority-types.ts";

export const MODEL_SAMPLE_EFFECT_NAME = "model.sample";
export const MODEL_SAMPLE_EFFECT_VERSION = "1";
export const MAX_OPEN_ELICITATIONS = 64;

export function effectContractDigest(definition: EffectDefinition<Json, Json, Json>): string {
  return canonicalSnapshot({
    kind: "sweatpants.effect-contract",
    digestVersion: 1,
    name: definition.name,
    version: definition.version,
    inputSchemaDigest: definition.inputSchema.digest,
    outputSchemaDigest: definition.outputSchema.digest,
    cancellationPartialSchemaDigest: definition.cancellation?.partialSchema.digest ?? null,
    retrySafety: definition.retrySafety,
  }).sha;
}

export function isModelSampleDescriptor(descriptor: DurableOperationDescriptor): boolean {
  return (
    descriptor.kind === "effect" &&
    descriptor.name === MODEL_SAMPLE_EFFECT_NAME &&
    descriptor.version === MODEL_SAMPLE_EFFECT_VERSION
  );
}

export function canonicalByteLength(value: Json): number {
  return new TextEncoder().encode(canonicalSnapshot(value).canonical).byteLength;
}

export function normalizeEmissionPolicy(
  policy: SemanticEmissionPolicy | undefined,
): SemanticEmissionPolicy | undefined {
  if (policy === undefined) return undefined;
  if (!isEmissionPolicyValue(policy)) {
    throw new CrankError("invalid_manifest", "Invalid semantic emission policy");
  }
  if (policy.maxEmissionsPerTask === undefined && policy.maxCumulativeEmissionBytes === undefined) {
    return undefined;
  }
  return structuredClone(policy);
}

const emissionPolicySchema = z.strictObject({
  maxEmissionsPerTask: z.number().int().nonnegative().optional(),
  maxCumulativeEmissionBytes: z.number().int().nonnegative().optional(),
});

export const emissionPolicyParser = parser(emissionPolicySchema).map(
  (value): SemanticEmissionPolicy => ({
    ...(value.maxEmissionsPerTask === undefined
      ? {}
      : { maxEmissionsPerTask: value.maxEmissionsPerTask }),
    ...(value.maxCumulativeEmissionBytes === undefined
      ? {}
      : { maxCumulativeEmissionBytes: value.maxCumulativeEmissionBytes }),
  }),
);

function isEmissionPolicyValue(value: unknown): value is SemanticEmissionPolicy {
  return emissionPolicyParser.parse(value).ok;
}

export function operationPolicy(
  manifest: DurableProgramManifest,
  descriptor: DurableOperationDescriptor,
): {
  resultDescriptor: PortableSchemaDescriptor;
  audience: string;
  inputDigest?: string;
  contextDigest?: string;
} {
  const declaredPolicy = pullKindPolicy(descriptor.kind);
  if (declaredPolicy?.resolutionTarget) {
    return declaredPolicy.resolutionTarget(descriptor, manifest);
  }
  switch (descriptor.kind) {
    case "record":
      if (
        typeof descriptor.key !== "string" ||
        descriptor.key.length === 0 ||
        new TextEncoder().encode(descriptor.key).byteLength > 128
      ) {
        throw new CrankError("invalid_descriptor", "Invalid record key");
      }
      return { resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR, audience: "program-execution" };
    case "effect": {
      const definition = manifest.effects[descriptor.name];
      if (!definition || definition.version !== descriptor.version) {
        throw new CrankError(
          "invalid_descriptor",
          `Undeclared effect ${descriptor.name}@${descriptor.version}`,
        );
      }
      return {
        resultDescriptor: definition.outputSchema,
        audience: descriptor.resolver.audience,
        inputDigest: definition.inputSchema.digest,
      };
    }
    case "elicit": {
      const declaration = manifest.elicits[descriptor.key];
      if (!declaration) {
        throw new CrankError("invalid_descriptor", `Undeclared elicitation ${descriptor.key}`);
      }
      if (declaration.response.digest !== descriptor.response.digest) {
        throw new CrankError(
          "invalid_descriptor",
          "Elicitation content schema differs from manifest",
        );
      }
      if ((declaration.context === undefined) !== (descriptor.context === undefined)) {
        throw new CrankError(
          "invalid_descriptor",
          "Elicitation authored context presence differs from manifest",
        );
      }
      return {
        resultDescriptor: declaration.response,
        audience: `user:${descriptor.key}`,
        ...(declaration.context !== undefined ? { contextDigest: declaration.context.digest } : {}),
      };
    }
    case "wait":
      if ((descriptor.notBefore === undefined) === (descriptor.durationMs === undefined)) {
        throw new CrankError("invalid_descriptor", "Wait requires exactly one deadline form");
      }
      if (
        descriptor.notBefore !== undefined &&
        !Number.isFinite(Date.parse(descriptor.notBefore))
      ) {
        throw new CrankError("invalid_descriptor", "Invalid wait deadline");
      }
      if (
        descriptor.durationMs !== undefined &&
        (!Number.isSafeInteger(descriptor.durationMs) || descriptor.durationMs < 0)
      ) {
        throw new CrankError("invalid_descriptor", "Invalid wait duration");
      }
      return { resultDescriptor: NULL_RESULT_SCHEMA_DESCRIPTOR, audience: "scheduler" };
    case "invoke":
    case "all":
    case "race":
    case "spawn":
    case "join":
      if (!manifest.capabilities.structuredChildren) {
        throw new CrankError("invalid_descriptor", "Program does not declare structured children");
      }
      return { resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR, audience: "child-runtime" };
  }
  // Registered interaction kinds resolved above; anything else is invalid.
  throw new CrankError("invalid_descriptor");
}

export function installedOrRecordedDescriptor(
  descriptor: DurableOperationDescriptor,
): Extract<DurableOperationDescriptor, { kind: "effect" | "record" }> {
  if (descriptor.kind !== "effect" && descriptor.kind !== "record") {
    throw new CrankError("invalid_descriptor", "Authorized pull is not executable");
  }
  return descriptor;
}

export function effectDigestForPull(
  manifest: DurableProgramManifest,
  descriptor: DurableOperationDescriptor,
): string {
  if (descriptor.kind !== "effect") {
    throw new CrankError("invalid_manifest", "Authorized pull is not an installed effect");
  }
  const definition = manifest.effects[descriptor.name];
  if (!definition || definition.version !== descriptor.version) {
    throw new CrankError("invalid_manifest", "Authorized effect contract is unavailable");
  }
  return effectContractDigest(definition);
}

const programElicitResultSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: z.json() }),
  z.strictObject({ action: z.literal("decline"), reason: z.string().optional() }),
  z.strictObject({ action: z.literal("cancel"), reason: z.string().optional() }),
]);

export const programElicitResultParser = parser(programElicitResultSchema).map(
  (value) =>
    value as
      | { action: "accept"; content: Json }
      | { action: "decline" | "cancel"; reason?: string },
);

export function parseProgramElicitResult(
  value: Json,
):
  | { action: "accept"; content: Json }
  | { action: "decline" | "cancel"; reason?: string }
  | undefined {
  const parsed = programElicitResultParser.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

export function snapshotDescriptor(
  descriptor: DurableOperationDescriptor,
): DurableOperationDescriptor {
  return canonicalSnapshot(descriptor).value;
}

export function snapshotOutcome(outcome: OperationOutcome): OperationOutcome {
  return canonicalSnapshot(outcome).value;
}

export function pendingReason(
  descriptor: DurableOperationDescriptor,
): "elicit" | "wait" | "child" | "foreign" | "sample" {
  const policy = pullKindPolicy(descriptor.kind);
  if (!policy) return "child";
  return (policy.pendingReason ?? descriptor.kind) as ReturnType<typeof pendingReason>;
}

export function sanitizeCancellationReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = [...reason]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized.slice(0, 512);
}

export function taskKey(sessionId: string, taskId: string): string {
  return stableTupleHash([sessionId, taskId]);
}

export function manifestSchemaDigests(manifest: DurableProgramManifest): string[] {
  return [
    manifest.inputSchema.digest,
    manifest.outputSchema.digest,
    ...Object.values(manifest.elicits).flatMap((elicit) => [
      elicit.response.digest,
      ...(elicit.context ? [elicit.context.digest] : []),
    ]),
    ...Object.values(manifest.effects).flatMap((effect) => [
      effect.inputSchema.digest,
      effect.outputSchema.digest,
      ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
    ]),
  ];
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function terminalOutcomeDigest(outcome: OperationOutcome): string {
  return canonicalSnapshot(outcome).sha;
}

export function identityConflict(
  domain: string,
  key: string,
  expected: string,
  observed: string | null,
) {
  return { domain, key, guard: "identity" as const, expected, observed };
}

const restoreTicketClaimsSchema = z.strictObject({
  version: z.literal(1),
  journalId: z.string().min(1),
  journalIncarnation: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  ownerId: z.string().min(1),
  activationEpoch: z.number().int().nonnegative(),
  releaseId: z.string().min(1).optional(),
  sandboxSessionId: z.string().min(1).optional(),
  replayDomain: z.string().min(1).optional(),
  frontierDomain: z.string().min(1).optional(),
  taskRevision: z.number().int().nonnegative(),
  journalHeadDigest: z.string().min(1),
  replayedThroughActionIndex: z.number().int().min(-1),
  replayChainDigest: z.string().min(1),
  restoreNonce: z.string().min(1),
});

export const restoreTicketClaimsParser = parser(restoreTicketClaimsSchema).map(
  (value): RestoreTicketClaims => ({
    version: value.version,
    journalId: value.journalId,
    journalIncarnation: value.journalIncarnation,
    sessionId: value.sessionId,
    taskId: value.taskId,
    ownerId: value.ownerId,
    activationEpoch: value.activationEpoch,
    ...(value.releaseId === undefined ? {} : { releaseId: value.releaseId }),
    ...(value.sandboxSessionId === undefined ? {} : { sandboxSessionId: value.sandboxSessionId }),
    ...(value.replayDomain === undefined ? {} : { replayDomain: value.replayDomain }),
    ...(value.frontierDomain === undefined ? {} : { frontierDomain: value.frontierDomain }),
    taskRevision: value.taskRevision,
    journalHeadDigest: value.journalHeadDigest,
    replayedThroughActionIndex: value.replayedThroughActionIndex,
    replayChainDigest: value.replayChainDigest,
    restoreNonce: value.restoreNonce,
  }),
);

export function parseRestoreTicketClaims(value: unknown): RestoreTicketClaims {
  const parsed = restoreTicketClaimsParser.parse(value);
  if (!parsed.ok) throw new CrankError("restore_stale");
  return parsed.value;
}
