import {
  CrankError,
  workflowDocumentStateSchema,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { registeredPullKinds } from "../pull-kinds/index.ts";
import { parser, assertJson, type Parser } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { z } from "zod";
import type { AuthorityState } from "../contract/authority-contract.ts";
import type { DurableAuthoritySnapshot } from "../state/authority-snapshot.ts";
import { JOURNAL_PAYLOAD_MAX_DEPTH } from "../contract/payload-limits.ts";

/** Pull kinds whose snapshot variants come straight from the registry. */
const PULL_KIND_SNAPSHOT_KINDS = new Set([
  "elicit",
  "sample",
  "ephemeral",
  "invoke",
  "spawn",
  "all",
  "race",
]);

export const DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_TASKS = 10_000;
const MAX_SNAPSHOT_COLLECTIONS = 10_000;
export const MAX_RECORDS_PER_SESSION = 100_000;
const MAX_ACTIONS_PER_TASK = 100_000;
const MAX_ATTEMPTS_PER_PULL = 10_000;
const MAX_CHILDREN_PER_OPERATION = 10_000;
const MAX_MANIFEST_ENTRIES = 10_000;

const unicodeStringSchema = z
  .string()
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value), "invalid Unicode");

const jsonRecordSchema = z.unknown().transform((value, context) => {
  try {
    const json = assertJson(value, "$", { maxDepth: JOURNAL_PAYLOAD_MAX_DEPTH });
    if (json !== null && typeof json === "object" && !Array.isArray(json)) {
      return json;
    }
  } catch {
    /* Report malformed JSON through the schema result. */
  }
  context.addIssue({ code: "custom", message: "expected JSON object" });
  return z.NEVER;
});
const jsonValueSchema = z.unknown().transform((value, context) => {
  try {
    return assertJson(value, "$", { maxDepth: JOURNAL_PAYLOAD_MAX_DEPTH });
  } catch {
    context.addIssue({ code: "custom", message: "invalid JSON value" });
    return z.NEVER;
  }
});
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const digestSchema = unicodeStringSchema.regex(/^[0-9a-f]{64}$/);
const portableSchemaDescriptorSchema = z.unknown().transform((value, context) => {
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid portable schema descriptor" });
    return z.NEVER;
  }
});

const retrySafetySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("repeatable") }),
  z.strictObject({ mode: z.literal("unsafe") }),
  z.strictObject({
    mode: z.literal("idempotent"),
    mechanism: z.enum(["pull_id_key", "inherent"]),
  }),
]);
const childSnapshotSchema = z.strictObject({
  id: unicodeStringSchema,
  version: unicodeStringSchema,
  digest: digestSchema,
  input: jsonValueSchema,
});
const registeredDescriptorSchemas = new Map(
  registeredPullKinds()
    .filter((policy) => PULL_KIND_SNAPSHOT_KINDS.has(policy.kind))
    .map((policy) => [policy.kind, policy.descriptorSchema]),
);
const descriptorSchemas = new Map<string, z.ZodType>([
  ...registeredDescriptorSchemas,
  [
    "record",
    z.strictObject({
      kind: z.literal("record"),
      key: z
        .string()
        .min(1)
        .refine((value) => new TextEncoder().encode(value).byteLength <= 128),
      retrySafety: retrySafetySchema,
    }),
  ],
  [
    "effect",
    z.strictObject({
      kind: z.literal("effect"),
      name: unicodeStringSchema,
      version: unicodeStringSchema,
      input: jsonValueSchema,
      resolver: z.strictObject({
        audience: unicodeStringSchema,
        route: unicodeStringSchema.optional(),
      }),
    }),
  ],
  [
    "wait",
    z
      .strictObject({
        kind: z.literal("wait"),
        key: unicodeStringSchema,
        notBefore: unicodeStringSchema.optional(),
        durationMs: nonNegativeIntegerSchema.optional(),
      })
      .refine(
        (value) =>
          (value.notBefore !== undefined && Number.isFinite(Date.parse(value.notBefore))) ||
          value.durationMs !== undefined,
      ),
  ],
  [
    "all",
    z.union([
      registeredDescriptorSchemas.get("all")!,
      z.strictObject({
        kind: z.literal("all"),
        children: z.array(childSnapshotSchema).max(MAX_CHILDREN_PER_OPERATION),
      }),
    ]),
  ],
  [
    "race",
    z.union([
      registeredDescriptorSchemas.get("race")!,
      z.strictObject({
        kind: z.literal("race"),
        children: z.array(childSnapshotSchema).max(MAX_CHILDREN_PER_OPERATION),
      }),
    ]),
  ],
  [
    "join",
    z.strictObject({
      kind: z.literal("join"),
      handle: z.strictObject({ __durableTask: unicodeStringSchema, owner: unicodeStringSchema }),
    }),
  ],
]);
// Select the declared kind before parsing. Trying every unrelated branch builds
// rejection trees for valid journal entries, especially on a cold restore.
const durableOperationDescriptorSchema = z.unknown().transform((value, context) => {
  const kind =
    value !== null && typeof value === "object" && "kind" in value ? value.kind : undefined;
  const schema = typeof kind === "string" ? descriptorSchemas.get(kind) : undefined;
  const parsed = schema?.safeParse(value);
  if (!parsed?.success) {
    context.addIssue({ code: "custom", message: "invalid durable operation descriptor" });
    return z.NEVER;
  }
  return parsed.data;
});

const programElicitDeclarationSchema = z.strictObject({
  response: portableSchemaDescriptorSchema,
  context: portableSchemaDescriptorSchema.optional(),
  contextContract: portableSchemaDescriptorSchema.optional(),
});
const programPullDeclarationSchema = z.strictObject({
  input: portableSchemaDescriptorSchema,
  output: portableSchemaDescriptorSchema,
});
const effectCancellationSchema = z.strictObject({ partialSchema: portableSchemaDescriptorSchema });
const effectDefinitionSchema = z.strictObject({
  name: unicodeStringSchema,
  version: unicodeStringSchema,
  inputSchema: portableSchemaDescriptorSchema,
  outputSchema: portableSchemaDescriptorSchema,
  retrySafety: retrySafetySchema,
  cancellation: effectCancellationSchema.optional(),
});
const durableProgramManifestSchema = z.strictObject({
  programId: unicodeStringSchema,
  version: unicodeStringSchema,
  digest: digestSchema,
  inputSchema: portableSchemaDescriptorSchema,
  outputSchema: portableSchemaDescriptorSchema,
  elicits: z
    .record(unicodeStringSchema, programElicitDeclarationSchema)
    .refine((value) => Object.keys(value).length <= MAX_MANIFEST_ENTRIES),
  effects: z
    .record(unicodeStringSchema, effectDefinitionSchema)
    .refine((value) => Object.keys(value).length <= MAX_MANIFEST_ENTRIES),
  pulls: z
    .record(unicodeStringSchema, programPullDeclarationSchema)
    .refine((value) => Object.keys(value).length <= MAX_MANIFEST_ENTRIES)
    .optional(),
  capabilities: z.strictObject({
    durableEmissions: z.boolean(),
    structuredChildren: z.boolean(),
    replay: z.literal("strict"),
  }),
});
/** Capture authored manifests in the same representation a restored task uses. */
export function parseDurableProgramManifest(value: unknown): DurableProgramManifest {
  const parsed = durableProgramManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CrankError("invalid_journal", "Invalid durable program manifest");
  }
  return parsed.data;
}

const operationOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: jsonValueSchema }),
  z.strictObject({
    status: z.literal("error"),
    error: z.strictObject({
      code: unicodeStringSchema,
      message: unicodeStringSchema,
      details: jsonValueSchema.optional(),
    }),
  }),
  z.strictObject({ status: z.literal("cancelled"), partial: jsonValueSchema.optional() }),
]);
const forkPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("single"), supervision: z.literal("single") }),
  z.strictObject({ mode: z.literal("all"), supervision: z.literal("one_for_all") }),
  z.strictObject({ mode: z.literal("race"), supervision: z.literal("first_success") }),
]);
const forkMemberBiographySchema = z.strictObject({
  ordinal: nonNegativeIntegerSchema,
  taskId: unicodeStringSchema,
  outcome: operationOutcomeSchema,
});
const forkGroupTerminalSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    winnerOrdinal: nonNegativeIntegerSchema.optional(),
    outcomes: z.array(forkMemberBiographySchema),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.strictObject({
      code: unicodeStringSchema,
      message: unicodeStringSchema,
      details: jsonValueSchema.optional(),
    }),
    outcomes: z.array(forkMemberBiographySchema),
  }),
  z.strictObject({
    status: z.literal("cancelled"),
    outcomes: z.array(forkMemberBiographySchema),
  }),
  z.strictObject({
    status: z.literal("expired"),
    outcomes: z.array(forkMemberBiographySchema),
  }),
  z.strictObject({ status: z.literal("orphaned"), reason: unicodeStringSchema }),
]);
const resolutionReceiptSchema = z.strictObject({
  sessionId: unicodeStringSchema,
  taskId: unicodeStringSchema,
  pullId: unicodeStringSchema,
  resolutionOffset: unicodeStringSchema,
  outcomeDigest: unicodeStringSchema,
  status: z.enum(["accepted", "duplicate"]),
});
const durablePositionSchema = unicodeStringSchema.regex(/^(0|[1-9]\d*)$/);
const modelContextPolicyDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("include-range"),
    fromPositionInclusive: durablePositionSchema,
    beforePositionExclusive: durablePositionSchema,
    reason: unicodeStringSchema.min(1),
  }),
  z.strictObject({
    type: z.literal("use-artifact"),
    artifactDigest: unicodeStringSchema.min(1),
    firstUncoveredPosition: durablePositionSchema,
    reason: unicodeStringSchema.min(1),
  }),
  z.strictObject({
    type: z.literal("drop-causal-group"),
    fromPositionInclusive: durablePositionSchema,
    beforePositionExclusive: durablePositionSchema,
    reason: unicodeStringSchema.min(1),
  }),
  z.strictObject({
    type: z.literal("history-policy"),
    policyId: unicodeStringSchema.min(1),
    action: z.enum(["drop_turn", "drop_message"]),
    reason: unicodeStringSchema.min(1),
    roles: z.array(unicodeStringSchema).max(64),
    toolCallIds: z.array(unicodeStringSchema).max(256),
  }),
]);
const modelContextPreparedFactSchema = z.strictObject({
  type: z.literal("ModelContextPrepared"),
  executionId: unicodeStringSchema.min(1),
  taskId: unicodeStringSchema.min(1),
  pullId: unicodeStringSchema.min(1),
  contextObject: z.strictObject({ objectId: unicodeStringSchema.min(1) }),
  contextDigest: unicodeStringSchema.min(1),
  invocationDigest: unicodeStringSchema.min(1),
  responseModeDigest: unicodeStringSchema.min(1),
  generationOptionsDigest: unicodeStringSchema.min(1),
  sourceCheckpoint: z.strictObject({ checkpointId: unicodeStringSchema.min(1) }),
  sourceArchiveHeadSegmentId: unicodeStringSchema.min(1).nullable(),
  sourceArchiveFrontierOrdinal: durablePositionSchema,
  sourceNextPublicPosition: durablePositionSchema,
  acceptedCommandId: unicodeStringSchema.min(1),
  policyId: unicodeStringSchema.min(1),
  policyDecisions: z.array(modelContextPolicyDecisionSchema).max(1_024),
  budgetId: unicodeStringSchema.min(1),
  budgetDigest: unicodeStringSchema.min(1),
  toolCatalogDigest: unicodeStringSchema.min(1),
  model: z.strictObject({ provider: unicodeStringSchema.min(1), id: unicodeStringSchema.min(1) }),
  publicMessageId: unicodeStringSchema.min(1),
});

const assistantPartialAcceptedFactSchema = z.strictObject({
  type: z.literal("AssistantPartialAccepted"),
  messageId: unicodeStringSchema.min(1),
  text: unicodeStringSchema.min(1).max(32_768),
  disposition: z.enum(["interrupted", "provider-error"]),
});

const taskCloseReceiptSchema = z.strictObject({
  offset: unicodeStringSchema,
  duplicate: z.boolean(),
});
const emissionPolicySnapshotSchema = z.strictObject({
  maxEmissionsPerTask: nonNegativeIntegerSchema.optional(),
  maxCumulativeEmissionBytes: nonNegativeIntegerSchema.optional(),
});
const cancellationFrontierSchema = z.strictObject({
  actionIndex: nonNegativeIntegerSchema,
  pullId: unicodeStringSchema.optional(),
});
const orphanReasonSchema = z.enum([
  "program_version_unavailable",
  "program_corrupt",
  "cleanup_stuck",
  "replay_execution_failed",
  "replay_diverged",
]);
const cancellationStateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("requested"),
    commandId: unicodeStringSchema,
    reason: unicodeStringSchema.optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("settling_pull"),
    commandId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    reason: unicodeStringSchema.optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("cancelling_children"),
    commandId: unicodeStringSchema,
    childTaskIds: z.array(unicodeStringSchema).max(MAX_CHILDREN_PER_OPERATION),
    reason: unicodeStringSchema.optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("unwinding"),
    commandId: unicodeStringSchema,
    reason: unicodeStringSchema.optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({ type: z.literal("cancelled"), commandId: unicodeStringSchema }),
  z.strictObject({ type: z.literal("orphaned"), reason: orphanReasonSchema }),
]);
const semanticPayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("TaskOpened"),
    taskId: unicodeStringSchema,
    turnId: unicodeStringSchema,
    programId: unicodeStringSchema,
    programVersion: unicodeStringSchema,
    programDigest: unicodeStringSchema,
    input: jsonValueSchema,
    inputDigest: unicodeStringSchema,
    catalog: jsonRecordSchema.optional(),
    catalogDigest: unicodeStringSchema.optional(),
    parentTaskId: unicodeStringSchema.optional(),
    parentPullId: unicodeStringSchema.optional(),
    elicitAudience: unicodeStringSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("AdvancementBound"),
    taskId: unicodeStringSchema,
    ownerId: unicodeStringSchema,
    leaseEpoch: nonNegativeIntegerSchema,
    expiresAtMs: z.number(),
    strandHeadDigest: digestSchema,
    forkGroupRevision: nonNegativeIntegerSchema,
    frontierDigest: digestSchema,
  }),
  z.strictObject({
    type: z.literal("AdvancementReleased"),
    taskId: unicodeStringSchema,
    leaseEpoch: nonNegativeIntegerSchema,
    reason: z.enum(["parked", "settled", "terminal", "failed", "scope_exit"]),
  }),
  z.strictObject({
    type: z.literal("PullRequested"),
    taskId: unicodeStringSchema,
    turnId: unicodeStringSchema,
    actionIndex: nonNegativeIntegerSchema,
    pullIndex: nonNegativeIntegerSchema,
    pullId: unicodeStringSchema,
    descriptor: durableOperationDescriptorSchema,
    descriptorDigest: unicodeStringSchema,
    publicMessageId: unicodeStringSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("ModelContextPrepared"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    fact: modelContextPreparedFactSchema,
    preparationDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("AssistantPartialAccepted"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    fact: assistantPartialAcceptedFactSchema,
    factDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("AttemptStarted"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    attemptIndex: nonNegativeIntegerSchema,
  }),
  z.strictObject({
    type: z.literal("AttemptDetached"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    reason: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("AttemptAbandoned"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    reason: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("AttemptSuperseded"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
    winnerAttemptId: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("PullIndeterminate"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("PullResolved"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema.optional(),
    outcome: operationOutcomeSchema,
    outcomeDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("DurableEmission"),
    taskId: unicodeStringSchema,
    actionIndex: nonNegativeIntegerSchema,
    emissionIndex: nonNegativeIntegerSchema,
    descriptor: z.strictObject({ eventType: unicodeStringSchema, payload: jsonValueSchema }),
    descriptorDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("RaceWinnerSelected"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    winnerTaskId: unicodeStringSchema,
    closeOffset: unicodeStringSchema,
    outcomeDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("CancellationRequested"),
    taskId: unicodeStringSchema,
    commandId: unicodeStringSchema,
    reason: unicodeStringSchema.optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("CancellationPartialDiscarded"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    reason: z.enum(["schema_validation_failed", "payload_too_large", "schema_version_unavailable"]),
  }),
  z.strictObject({
    type: z.literal("AttemptOutcomeUnknown"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    attemptId: unicodeStringSchema.optional(),
    reason: z.enum(["no_settlement_path", "force_orphaned"]),
  }),
  z.strictObject({
    type: z.literal("CleanupSkipped"),
    taskId: unicodeStringSchema,
    reason: orphanReasonSchema,
  }),
  z.strictObject({
    type: z.literal("TaskOrphaned"),
    taskId: unicodeStringSchema,
    reason: orphanReasonSchema,
  }),
  z.strictObject({
    type: z.literal("TaskClosed"),
    taskId: unicodeStringSchema,
    outcome: operationOutcomeSchema,
  }),
  z.strictObject({
    type: z.literal("ForkGroupOpened"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    groupId: unicodeStringSchema,
    policy: forkPolicySchema,
    deadlineMs: z.number(),
    memberTaskIds: z.array(unicodeStringSchema).max(MAX_CHILDREN_PER_OPERATION),
    descriptorDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("ForkGroupBreached"),
    taskId: unicodeStringSchema,
    groupId: unicodeStringSchema,
    deadlineMs: z.number(),
    breachedAtMs: z.number(),
  }),
  z.strictObject({
    type: z.literal("ForkGroupResolved"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    groupId: unicodeStringSchema,
    terminal: forkGroupTerminalSchema,
    terminalDigest: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("ForkGroupOrphaned"),
    taskId: unicodeStringSchema,
    pullId: unicodeStringSchema,
    groupId: unicodeStringSchema,
    reason: unicodeStringSchema,
  }),
  z.strictObject({
    type: z.literal("PeerDelegationCommitted"),
    taskId: unicodeStringSchema,
    groupId: unicodeStringSchema,
    memberTaskId: unicodeStringSchema,
    correlator: unicodeStringSchema,
    peer: unicodeStringSchema,
    deadlineMs: z.number(),
  }),
]);
const semanticRecordSchema = z.strictObject({
  offset: unicodeStringSchema,
  eventId: unicodeStringSchema,
  sessionId: unicodeStringSchema,
  ownerEpoch: nonNegativeIntegerSchema.optional(),
  payload: semanticPayloadSchema,
});
const recordCollectionSchema = z.tuple([
  unicodeStringSchema,
  z.array(semanticRecordSchema).max(MAX_RECORDS_PER_SESSION),
]);
const activationLeaseValueSchema = z.strictObject({
  sessionId: unicodeStringSchema,
  ownerId: unicodeStringSchema,
  epoch: nonNegativeIntegerSchema,
  expiresAtMs: nonNegativeIntegerSchema,
  leaseDurationMs: nonNegativeIntegerSchema,
  claimedTaskRevision: nonNegativeIntegerSchema,
  claimedHeadId: unicodeStringSchema,
  restoreNonce: unicodeStringSchema,
});
const taskOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({
    kind: z.literal("child"),
    invokedBy: z.strictObject({ taskId: unicodeStringSchema, pullId: unicodeStringSchema }),
  }),
]);
const resolutionAuthoritySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attempt"),
    owner: z.enum(["program", "effect"]),
    audience: unicodeStringSchema,
  }),
  z.strictObject({
    kind: z.literal("participant"),
    audience: unicodeStringSchema,
    capability: unicodeStringSchema,
  }),
  z.strictObject({
    kind: z.literal("clock"),
    audience: unicodeStringSchema,
    notBefore: unicodeStringSchema,
    capability: unicodeStringSchema,
  }),
  z.strictObject({
    kind: z.literal("child"),
    mode: z.enum(["invoke", "all", "race", "spawn", "join"]),
    audience: unicodeStringSchema,
    capability: unicodeStringSchema,
  }),
]);
const attemptSchema = z.strictObject({
  attemptId: unicodeStringSchema,
  attemptIndex: nonNegativeIntegerSchema,
  capability: unicodeStringSchema,
  status: z.enum(["started", "detached", "completed", "revoked", "superseded"]),
});
const pullResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("open"), revoked: z.boolean() }),
  z.strictObject({
    status: z.literal("settled"),
    revoked: z.boolean(),
    settlement: z.strictObject({
      outcome: operationOutcomeSchema,
      outcomeDigest: unicodeStringSchema,
      receipt: resolutionReceiptSchema,
    }),
  }),
]);
const pullSchema = z.strictObject({
  pullId: unicodeStringSchema,
  request: z.strictObject({
    proposedDescriptorDigest: unicodeStringSchema,
    proposedDescriptor: durableOperationDescriptorSchema,
    acceptedDescriptor: durableOperationDescriptorSchema,
    resultDescriptor: portableSchemaDescriptorSchema,
    resultSchemaDigest: unicodeStringSchema,
    maxOutcomeBytes: nonNegativeIntegerSchema,
    publicMessageId: unicodeStringSchema.optional(),
  }),
  resolutionAuthority: resolutionAuthoritySchema,
  attempts: z.array(attemptSchema).max(MAX_ATTEMPTS_PER_PULL),
  acceptedFacts: z.strictObject({
    preparation: modelContextPreparedFactSchema.optional(),
    preparationDigest: unicodeStringSchema.optional(),
    assistantPartial: assistantPartialAcceptedFactSchema.optional(),
    assistantPartialDigest: unicodeStringSchema.optional(),
  }),
  resolution: pullResolutionSchema,
});
const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pull"),
    actionIndex: nonNegativeIntegerSchema,
    pullIndex: nonNegativeIntegerSchema,
    pull: pullSchema,
  }),
  z.strictObject({
    kind: z.literal("emission"),
    actionIndex: nonNegativeIntegerSchema,
    emissionIndex: nonNegativeIntegerSchema,
    descriptorDigest: unicodeStringSchema,
    receipt: z.strictObject({
      offset: unicodeStringSchema,
      eventId: unicodeStringSchema,
      duplicate: z.boolean(),
    }),
  }),
]);
const taskLifecycleSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("active"), cancellation: cancellationStateSchema }),
  z.strictObject({
    status: z.literal("closed"),
    outcome: operationOutcomeSchema,
    receipt: taskCloseReceiptSchema,
  }),
  z.strictObject({
    status: z.literal("cancelled"),
    outcome: z.strictObject({
      status: z.literal("cancelled"),
      partial: jsonValueSchema.optional(),
    }),
    receipt: taskCloseReceiptSchema,
    commandId: unicodeStringSchema,
  }),
  z.strictObject({ status: z.literal("orphaned"), reason: orphanReasonSchema }),
]);
const forkGroupMemberSchema = z.strictObject({
  ordinal: nonNegativeIntegerSchema,
  taskId: unicodeStringSchema,
  durability: z.enum(["crank_native", "peer_hosted"]).optional(),
  peer: unicodeStringSchema.optional(),
  sampling: z.enum(["delegated", "private"]).optional(),
  delegationCorrelator: unicodeStringSchema.optional(),
  terminal: z
    .strictObject({ outcome: operationOutcomeSchema, outcomeDigest: unicodeStringSchema })
    .optional(),
});
const forkGroupStateSchema = z.strictObject({
  revision: nonNegativeIntegerSchema.optional(),
  groupId: unicodeStringSchema,
  parentTaskId: unicodeStringSchema,
  pullId: unicodeStringSchema,
  descriptorDigest: unicodeStringSchema,
  policy: forkPolicySchema,
  deadlineMs: z.number(),
  members: z.array(forkGroupMemberSchema).max(MAX_CHILDREN_PER_OPERATION),
  status: z.enum(["open", "cancelling", "resolved"]),
  cancellingCause: z.enum(["failure", "race_winner", "expiry", "cancellation"]).optional(),
  breachedAtMs: z.number().optional(),
  winner: z
    .strictObject({ ordinal: nonNegativeIntegerSchema, outcomeDigest: unicodeStringSchema })
    .optional(),
  resolution: forkGroupTerminalSchema.optional(),
});
const taskSchema = z.strictObject({
  taskId: unicodeStringSchema,
  turnId: unicodeStringSchema,
  origin: taskOriginSchema,
  deadlineMs: z.number().optional(),
  forkGroup: forkGroupStateSchema.optional(),
  program: z.strictObject({
    artifact: z.strictObject({
      id: unicodeStringSchema,
      version: unicodeStringSchema,
      digest: digestSchema,
    }),
    manifest: durableProgramManifestSchema,
    input: jsonValueSchema,
  }),
  execution: z.strictObject({
    epoch: nonNegativeIntegerSchema,
    attachmentId: unicodeStringSchema,
    audience: unicodeStringSchema,
    elicitAudience: unicodeStringSchema.optional(),
    route: z.union([unicodeStringSchema, jsonRecordSchema]).optional(),
    catalog: jsonValueSchema.optional(),
    catalogDigest: unicodeStringSchema.optional(),
    liveLease: z
      .strictObject({
        ownerId: unicodeStringSchema,
        epoch: nonNegativeIntegerSchema,
        expiresAtMs: z.number(),
        attachmentId: unicodeStringSchema,
        strandHeadDigest: digestSchema,
        forkGroupRevision: nonNegativeIntegerSchema,
        frontierDigest: digestSchema,
      })
      .optional(),
  }),
  actions: z.array(actionSchema).max(MAX_ACTIONS_PER_TASK),
  nextActionIndex: nonNegativeIntegerSchema,
  nextPullIndex: nonNegativeIntegerSchema,
  nextEmissionIndex: nonNegativeIntegerSchema,
  emissionPolicy: emissionPolicySnapshotSchema.optional(),
  acceptedEmissionCount: nonNegativeIntegerSchema,
  cumulativeEmissionBytes: nonNegativeIntegerSchema,
  lifecycle: taskLifecycleSchema,
});
const sessionSchema = z.strictObject({
  execution: z.strictObject({ tasks: z.array(taskSchema).max(MAX_SNAPSHOT_TASKS) }),
  control: z.strictObject({
    journalHeadId: unicodeStringSchema.uuid().nullable(),
    runnable: z.boolean(),
    revision: nonNegativeIntegerSchema,
    nextRootOrdinal: nonNegativeIntegerSchema.optional(),
    activationLease: activationLeaseValueSchema.optional(),
    lastActivationEpoch: nonNegativeIntegerSchema,
    restoreNonce: unicodeStringSchema.optional(),
    restoreFrontierDigest: unicodeStringSchema.optional(),
    consecutiveRestoreStales: nonNegativeIntegerSchema,
    activationNotBeforeMs: nonNegativeIntegerSchema.optional(),
    documents: workflowDocumentStateSchema.optional(),
  }),
});
const durableAuthoritySnapshotStructureSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(z.tuple([unicodeStringSchema, sessionSchema])).max(MAX_SNAPSHOT_COLLECTIONS),
  nextNonce: nonNegativeIntegerSchema,
  records: z.array(recordCollectionSchema).max(MAX_SNAPSHOT_COLLECTIONS),
});

/** Cold/import boundary: validate the entire current persisted representation.
 * JSON payload depth is bounded at each JSON-valued leaf, independently of the
 * statically bounded journal envelope. Encoded bytes and collection counts are
 * the aggregate storage budget; there is no separate primitive-node budget.
 */
export const durableAuthoritySnapshotStructureParser: Parser<unknown> = parser(
  durableAuthoritySnapshotStructureSchema,
);

// New task input is the owned, depth-bounded result returned by the registered
// input schema. The cold schema still captures external persisted JSON.
const newTaskSchema = taskSchema.extend({
  program: taskSchema.shape.program.extend({ input: z.unknown() }),
});
const taskEditSchema = taskSchema.omit({ actions: true, execution: true, forkGroup: true });
const forkEditSchema = forkGroupStateSchema.omit({ members: true });
const pullEditSchema = pullSchema.omit({ acceptedFacts: true });
const snapshotHeaderSchema = durableAuthoritySnapshotStructureSchema.omit({
  sessions: true,
  records: true,
});

/** The draft retains immutable payloads by reference. Only changed fields cross
 * admission; mutable counters and collection sizes remain inexpensive checks.
 */
export function validateSnapshotMutation(
  previous: AuthorityState,
  snapshot: DurableAuthoritySnapshot,
): void {
  snapshotHeaderSchema.parse({ version: snapshot.version, nextNonce: snapshot.nextNonce });
  if (
    snapshot.sessions.length > MAX_SNAPSHOT_COLLECTIONS ||
    snapshot.records.length > MAX_SNAPSHOT_COLLECTIONS
  ) {
    throw new CrankError("invalid_journal", "Authority collection limit exceeded");
  }
  for (const [sessionId, session] of snapshot.sessions) {
    unicodeStringSchema.parse(sessionId);
    const accepted = previous.sessions.get(sessionId);
    if (session.control !== accepted?.control) {
      sessionSchema.shape.control.parse(session.control);
    }
    if (session.execution.tasks.length > MAX_SNAPSHOT_TASKS) {
      throw new CrankError("invalid_journal", "Authority task limit exceeded");
    }
    for (const task of session.execution.tasks) {
      const before = accepted?.execution.tasks.get(task.taskId);
      if (task === before) {
        continue;
      }
      if (!before) {
        newTaskSchema.parse(task);
        continue;
      }
      const { actions, execution, forkGroup, ...fields } = task;
      const {
        actions: _oldActions,
        execution: _oldExecution,
        forkGroup: _oldFork,
        ...oldFields
      } = before;
      validateChangedFields(taskEditSchema, oldFields, fields);
      validateChangedFields(taskSchema.shape.execution, before.execution, execution);
      if (forkGroup !== before.forkGroup) {
        if (!forkGroup || !before.forkGroup) {
          taskSchema.shape.forkGroup.parse(forkGroup);
        } else {
          const { members, ...fork } = forkGroup;
          const { members: oldMembers, ...oldFork } = before.forkGroup;
          validateChangedFields(forkEditSchema, oldFork, fork);
          if (members.length > MAX_CHILDREN_PER_OPERATION) {
            throw new CrankError("invalid_journal", "Fork member limit exceeded");
          }
          for (const [index, member] of members.entries()) {
            if (oldMembers[index]) {
              validateChangedFields(forkGroupMemberSchema, oldMembers[index], member);
            } else {
              forkGroupMemberSchema.parse(member);
            }
          }
        }
      }
      if (actions.length > MAX_ACTIONS_PER_TASK) {
        throw new CrankError("invalid_journal", "Authority action limit exceeded");
      }
      for (const [index, action] of actions.entries()) {
        const earlier = before.actions[index];
        if (action === earlier) {
          continue;
        }
        if (action.kind !== "pull" || earlier?.kind !== "pull") {
          actionSchema.parse(action);
          continue;
        }
        // Action identity and ordering are checked by the shared decision path.
        const { acceptedFacts, ...pull } = action.pull;
        const { acceptedFacts: _oldFacts, ...oldPull } = earlier.pull;
        validateChangedFields(pullEditSchema, oldPull, pull);
        validateChangedFields(
          pullSchema.shape.acceptedFacts,
          earlier.pull.acceptedFacts,
          acceptedFacts,
        );
      }
    }
  }
}

function validateChangedFields(schema: z.ZodObject, previous: object, next: object): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const value = Reflect.get(next, key);
    if (Reflect.get(previous, key) === value) {
      continue;
    }
    const field = schema.shape[key];
    if (!field) {
      throw new CrankError("invalid_journal", "Unknown authority field");
    }
    field.parse(value);
  }
}
