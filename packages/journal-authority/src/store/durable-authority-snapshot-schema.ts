import type { StandardSchemaV1 } from "@standard-schema/spec";
import { CrankError, type DurableProgramManifest } from "@sweatpants/durable-execution";
import { registeredPullKinds } from "../pull-kinds/index.ts";
import { parser, assertJson, type Parser } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { z } from "zod";

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
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_NODES = 2_000_000;
const MAX_SNAPSHOT_TASKS = 10_000;
const MAX_SNAPSHOT_COLLECTIONS = 10_000;
export const MAX_RECORDS_PER_SESSION = 100_000;
const MAX_ACTIONS_PER_TASK = 100_000;
const MAX_ATTEMPTS_PER_PULL = 10_000;
const MAX_CHILDREN_PER_OPERATION = 10_000;
const MAX_MANIFEST_ENTRIES = 10_000;

const jsonRecordSchema = z.unknown().transform((value, context) => {
  try {
    const json = assertJson(value);
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
    return assertJson(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid JSON value" });
    return z.NEVER;
  }
});
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
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
  id: z.string(),
  version: z.string(),
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
      name: z.string(),
      version: z.string(),
      input: jsonValueSchema,
      resolver: z.strictObject({ audience: z.string(), route: z.string().optional() }),
    }),
  ],
  [
    "wait",
    z
      .strictObject({
        kind: z.literal("wait"),
        key: z.string(),
        notBefore: z.string().optional(),
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
      handle: z.strictObject({ __durableTask: z.string(), owner: z.string() }),
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
  name: z.string(),
  version: z.string(),
  inputSchema: portableSchemaDescriptorSchema,
  outputSchema: portableSchemaDescriptorSchema,
  retrySafety: retrySafetySchema,
  cancellation: effectCancellationSchema.optional(),
});
const durableProgramManifestSchema = z.strictObject({
  programId: z.string(),
  version: z.string(),
  digest: digestSchema,
  inputSchema: portableSchemaDescriptorSchema,
  outputSchema: portableSchemaDescriptorSchema,
  elicits: z
    .record(z.string(), programElicitDeclarationSchema)
    .refine((value) => Object.keys(value).length <= MAX_MANIFEST_ENTRIES),
  effects: z
    .record(z.string(), effectDefinitionSchema)
    .refine((value) => Object.keys(value).length <= MAX_MANIFEST_ENTRIES),
  pulls: z
    .record(z.string(), programPullDeclarationSchema)
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
      code: z.string(),
      message: z.string(),
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
  taskId: z.string(),
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
      code: z.string(),
      message: z.string(),
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
  z.strictObject({ status: z.literal("orphaned"), reason: z.string() }),
]);
const resolutionReceiptSchema = z.strictObject({
  sessionId: z.string(),
  taskId: z.string(),
  pullId: z.string(),
  resolutionOffset: z.string(),
  outcomeDigest: z.string(),
  status: z.enum(["accepted", "duplicate"]),
});
const durablePositionSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const modelContextPolicyDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("include-range"),
    fromPositionInclusive: durablePositionSchema,
    beforePositionExclusive: durablePositionSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("use-artifact"),
    artifactDigest: z.string().min(1),
    firstUncoveredPosition: durablePositionSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("drop-causal-group"),
    fromPositionInclusive: durablePositionSchema,
    beforePositionExclusive: durablePositionSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("history-policy"),
    policyId: z.string().min(1),
    action: z.enum(["drop_turn", "drop_message"]),
    reason: z.string().min(1),
    roles: z.array(z.string()).max(64),
    toolCallIds: z.array(z.string()).max(256),
  }),
]);
const modelContextPreparedFactSchema = z.strictObject({
  type: z.literal("ModelContextPrepared"),
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  pullId: z.string().min(1),
  contextObject: z.strictObject({ objectId: z.string().min(1) }),
  contextDigest: z.string().min(1),
  invocationDigest: z.string().min(1),
  responseModeDigest: z.string().min(1),
  generationOptionsDigest: z.string().min(1),
  sourceCheckpoint: z.strictObject({ checkpointId: z.string().min(1) }),
  sourceArchiveHeadSegmentId: z.string().min(1).nullable(),
  sourceArchiveFrontierOrdinal: durablePositionSchema,
  sourceNextPublicPosition: durablePositionSchema,
  acceptedCommandId: z.string().min(1),
  policyId: z.string().min(1),
  policyDecisions: z.array(modelContextPolicyDecisionSchema).max(1_024),
  budgetId: z.string().min(1),
  budgetDigest: z.string().min(1),
  toolCatalogDigest: z.string().min(1),
  model: z.strictObject({ provider: z.string().min(1), id: z.string().min(1) }),
  publicMessageId: z.string().min(1),
});

const assistantPartialAcceptedFactSchema = z.strictObject({
  type: z.literal("AssistantPartialAccepted"),
  messageId: z.string().min(1),
  text: z.string().min(1).max(32_768),
  disposition: z.enum(["interrupted", "provider-error"]),
});

const taskCloseReceiptSchema = z.strictObject({ offset: z.string(), duplicate: z.boolean() });
const emissionPolicySnapshotSchema = z.strictObject({
  maxEmissionsPerTask: nonNegativeIntegerSchema.optional(),
  maxCumulativeEmissionBytes: nonNegativeIntegerSchema.optional(),
});
const cancellationFrontierSchema = z.strictObject({
  actionIndex: nonNegativeIntegerSchema,
  pullId: z.string().optional(),
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
    commandId: z.string(),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("settling_pull"),
    commandId: z.string(),
    pullId: z.string(),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("cancelling_children"),
    commandId: z.string(),
    childTaskIds: z.array(z.string()).max(MAX_CHILDREN_PER_OPERATION),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("unwinding"),
    commandId: z.string(),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({ type: z.literal("cancelled"), commandId: z.string() }),
  z.strictObject({ type: z.literal("orphaned"), reason: orphanReasonSchema }),
]);
const semanticPayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("TaskOpened"),
    taskId: z.string(),
    turnId: z.string(),
    programId: z.string(),
    programVersion: z.string(),
    programDigest: z.string(),
    input: jsonValueSchema,
    inputDigest: z.string(),
    catalog: jsonRecordSchema.optional(),
    catalogDigest: z.string().optional(),
    parentTaskId: z.string().optional(),
    parentPullId: z.string().optional(),
    elicitAudience: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("AdvancementBound"),
    taskId: z.string(),
    ownerId: z.string(),
    leaseEpoch: nonNegativeIntegerSchema,
    expiresAtMs: z.number(),
    strandHeadDigest: digestSchema,
    forkGroupRevision: nonNegativeIntegerSchema,
    frontierDigest: digestSchema,
  }),
  z.strictObject({
    type: z.literal("AdvancementReleased"),
    taskId: z.string(),
    leaseEpoch: nonNegativeIntegerSchema,
    reason: z.enum(["parked", "settled", "terminal", "failed", "scope_exit"]),
  }),
  z.strictObject({
    type: z.literal("PullRequested"),
    taskId: z.string(),
    turnId: z.string(),
    actionIndex: nonNegativeIntegerSchema,
    pullIndex: nonNegativeIntegerSchema,
    pullId: z.string(),
    descriptor: durableOperationDescriptorSchema,
    descriptorDigest: z.string(),
    publicMessageId: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("ModelContextPrepared"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    fact: modelContextPreparedFactSchema,
    preparationDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("AssistantPartialAccepted"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    fact: assistantPartialAcceptedFactSchema,
    factDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("AttemptStarted"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    attemptIndex: nonNegativeIntegerSchema,
  }),
  z.strictObject({
    type: z.literal("AttemptDetached"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal("AttemptAbandoned"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal("AttemptSuperseded"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
    winnerAttemptId: z.string(),
  }),
  z.strictObject({
    type: z.literal("PullIndeterminate"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string(),
  }),
  z.strictObject({
    type: z.literal("PullResolved"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string().optional(),
    outcome: operationOutcomeSchema,
    outcomeDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("DurableEmission"),
    taskId: z.string(),
    actionIndex: nonNegativeIntegerSchema,
    emissionIndex: nonNegativeIntegerSchema,
    descriptor: z.strictObject({ eventType: z.string(), payload: jsonValueSchema }),
    descriptorDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("RaceWinnerSelected"),
    taskId: z.string(),
    pullId: z.string(),
    winnerTaskId: z.string(),
    closeOffset: z.string(),
    outcomeDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("CancellationRequested"),
    taskId: z.string(),
    commandId: z.string(),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("CancellationPartialDiscarded"),
    taskId: z.string(),
    pullId: z.string(),
    reason: z.enum(["schema_validation_failed", "payload_too_large", "schema_version_unavailable"]),
  }),
  z.strictObject({
    type: z.literal("AttemptOutcomeUnknown"),
    taskId: z.string(),
    pullId: z.string(),
    attemptId: z.string().optional(),
    reason: z.enum(["no_settlement_path", "force_orphaned"]),
  }),
  z.strictObject({
    type: z.literal("CleanupSkipped"),
    taskId: z.string(),
    reason: orphanReasonSchema,
  }),
  z.strictObject({
    type: z.literal("TaskOrphaned"),
    taskId: z.string(),
    reason: orphanReasonSchema,
  }),
  z.strictObject({
    type: z.literal("TaskClosed"),
    taskId: z.string(),
    outcome: operationOutcomeSchema,
  }),
  z.strictObject({
    type: z.literal("ForkGroupOpened"),
    taskId: z.string(),
    pullId: z.string(),
    groupId: z.string(),
    policy: forkPolicySchema,
    deadlineMs: z.number(),
    memberTaskIds: z.array(z.string()).max(MAX_CHILDREN_PER_OPERATION),
    descriptorDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("ForkGroupBreached"),
    taskId: z.string(),
    groupId: z.string(),
    deadlineMs: z.number(),
    breachedAtMs: z.number(),
  }),
  z.strictObject({
    type: z.literal("ForkGroupResolved"),
    taskId: z.string(),
    pullId: z.string(),
    groupId: z.string(),
    terminal: forkGroupTerminalSchema,
    terminalDigest: z.string(),
  }),
  z.strictObject({
    type: z.literal("ForkGroupOrphaned"),
    taskId: z.string(),
    pullId: z.string(),
    groupId: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal("PeerDelegationCommitted"),
    taskId: z.string(),
    groupId: z.string(),
    memberTaskId: z.string(),
    correlator: z.string(),
    peer: z.string(),
    deadlineMs: z.number(),
  }),
]);
const semanticRecordSchema = z.strictObject({
  offset: z.string(),
  eventId: z.string(),
  sessionId: z.string(),
  ownerEpoch: nonNegativeIntegerSchema.optional(),
  payload: semanticPayloadSchema,
});
const recordCollectionSchema = z.tuple([
  z.string(),
  z.array(semanticRecordSchema).max(MAX_RECORDS_PER_SESSION),
]);
const activationLeaseValueSchema = z.strictObject({
  sessionId: z.string(),
  ownerId: z.string(),
  epoch: nonNegativeIntegerSchema,
  expiresAtMs: nonNegativeIntegerSchema,
  leaseDurationMs: nonNegativeIntegerSchema,
  claimedTaskRevision: nonNegativeIntegerSchema,
  claimedHeadId: z.string(),
  restoreNonce: z.string(),
});
const taskOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({
    kind: z.literal("child"),
    invokedBy: z.strictObject({ taskId: z.string(), pullId: z.string() }),
  }),
]);
const resolutionAuthoritySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attempt"),
    owner: z.enum(["program", "effect"]),
    audience: z.string(),
  }),
  z.strictObject({ kind: z.literal("participant"), audience: z.string(), capability: z.string() }),
  z.strictObject({
    kind: z.literal("clock"),
    audience: z.string(),
    notBefore: z.string(),
    capability: z.string(),
  }),
  z.strictObject({
    kind: z.literal("child"),
    mode: z.enum(["invoke", "all", "race", "spawn", "join"]),
    audience: z.string(),
    capability: z.string(),
  }),
]);
const attemptSchema = z.strictObject({
  attemptId: z.string(),
  attemptIndex: nonNegativeIntegerSchema,
  capability: z.string(),
  status: z.enum(["started", "detached", "completed", "revoked", "superseded"]),
});
const pullResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("open"), revoked: z.boolean() }),
  z.strictObject({
    status: z.literal("settled"),
    revoked: z.boolean(),
    settlement: z.strictObject({
      outcome: operationOutcomeSchema,
      outcomeDigest: z.string(),
      receipt: resolutionReceiptSchema,
    }),
  }),
]);
const pullSchema = z.strictObject({
  pullId: z.string(),
  request: z.strictObject({
    proposedDescriptorDigest: z.string(),
    proposedDescriptor: durableOperationDescriptorSchema,
    acceptedDescriptor: durableOperationDescriptorSchema,
    resultDescriptor: portableSchemaDescriptorSchema,
    resultSchemaDigest: z.string(),
    maxOutcomeBytes: nonNegativeIntegerSchema,
    publicMessageId: z.string().optional(),
  }),
  resolutionAuthority: resolutionAuthoritySchema,
  attempts: z.array(attemptSchema).max(MAX_ATTEMPTS_PER_PULL),
  acceptedFacts: z.strictObject({
    preparation: modelContextPreparedFactSchema.optional(),
    preparationDigest: z.string().optional(),
    assistantPartial: assistantPartialAcceptedFactSchema.optional(),
    assistantPartialDigest: z.string().optional(),
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
    descriptorDigest: z.string(),
    receipt: z.strictObject({
      offset: z.string(),
      eventId: z.string(),
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
    commandId: z.string(),
  }),
  z.strictObject({ status: z.literal("orphaned"), reason: orphanReasonSchema }),
]);
const forkGroupMemberSchema = z.strictObject({
  ordinal: nonNegativeIntegerSchema,
  taskId: z.string(),
  durability: z.enum(["crank_native", "peer_hosted"]).optional(),
  peer: z.string().optional(),
  sampling: z.enum(["delegated", "private"]).optional(),
  delegationCorrelator: z.string().optional(),
  terminal: z
    .strictObject({ outcome: operationOutcomeSchema, outcomeDigest: z.string() })
    .optional(),
});
const forkGroupStateSchema = z.strictObject({
  revision: nonNegativeIntegerSchema.optional(),
  groupId: z.string(),
  parentTaskId: z.string(),
  pullId: z.string(),
  descriptorDigest: z.string(),
  policy: forkPolicySchema,
  deadlineMs: z.number(),
  members: z.array(forkGroupMemberSchema).max(MAX_CHILDREN_PER_OPERATION),
  status: z.enum(["open", "cancelling", "resolved"]),
  cancellingCause: z.enum(["failure", "race_winner", "expiry", "cancellation"]).optional(),
  breachedAtMs: z.number().optional(),
  winner: z
    .strictObject({ ordinal: nonNegativeIntegerSchema, outcomeDigest: z.string() })
    .optional(),
  resolution: forkGroupTerminalSchema.optional(),
});
const taskSchema = z.strictObject({
  taskId: z.string(),
  turnId: z.string(),
  origin: taskOriginSchema,
  deadlineMs: z.number().optional(),
  forkGroup: forkGroupStateSchema.optional(),
  program: z.strictObject({
    artifact: z.strictObject({ id: z.string(), version: z.string(), digest: digestSchema }),
    manifest: durableProgramManifestSchema,
    input: jsonValueSchema,
  }),
  execution: z.strictObject({
    epoch: nonNegativeIntegerSchema,
    attachmentId: z.string(),
    audience: z.string(),
    elicitAudience: z.string().optional(),
    route: z.union([z.string(), jsonRecordSchema]).optional(),
    catalog: jsonValueSchema.optional(),
    catalogDigest: z.string().optional(),
    liveLease: z
      .strictObject({
        ownerId: z.string(),
        epoch: nonNegativeIntegerSchema,
        expiresAtMs: z.number(),
        attachmentId: z.string(),
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
    journalHeadId: z.string().uuid().nullable(),
    runnable: z.boolean(),
    revision: nonNegativeIntegerSchema,
    nextRootOrdinal: nonNegativeIntegerSchema.optional(),
    activationLease: activationLeaseValueSchema.optional(),
    lastActivationEpoch: nonNegativeIntegerSchema,
    restoreNonce: z.string().optional(),
    restoreFrontierDigest: z.string().optional(),
    consecutiveRestoreStales: nonNegativeIntegerSchema,
    activationNotBeforeMs: nonNegativeIntegerSchema.optional(),
  }),
});
const durableAuthoritySnapshotStructureSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(z.tuple([z.string(), sessionSchema])).max(MAX_SNAPSHOT_COLLECTIONS),
  nextNonce: nonNegativeIntegerSchema,
  records: z.array(recordCollectionSchema).max(MAX_SNAPSHOT_COLLECTIONS),
});
const boundedSnapshotValueSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "sweatpants",
    validate(value) {
      try {
        const seen = new WeakSet();
        const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [
          { value, depth: 0 },
        ];
        let nodes = 0;
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (current.exit) {
            seen.delete(current.value as object);
            continue;
          }
          nodes += 1;
          if (nodes > MAX_SNAPSHOT_NODES) {
            return { issues: [{ message: "snapshot node count exceeds limit" }] };
          }
          if (current.depth > MAX_SNAPSHOT_DEPTH) {
            return { issues: [{ message: "snapshot depth exceeds limit" }] };
          }
          if (typeof current.value === "string" && /[\uD800-\uDFFF]/u.test(current.value)) {
            return { issues: [{ message: "snapshot contains invalid Unicode" }] };
          }
          if (current.value === null || typeof current.value !== "object") {
            continue;
          }
          if (seen.has(current.value)) {
            return { issues: [{ message: "snapshot contains a cycle" }] };
          }
          seen.add(current.value);
          pending.push({ ...current, exit: true });
          for (const [key, child] of Object.entries(current.value)) {
            if (key === "__proto__" || /[\uD800-\uDFFF]/u.test(key)) {
              return { issues: [{ message: "snapshot contains an invalid key" }] };
            }
            pending.push({ value: child, depth: current.depth + 1 });
          }
        }
        return { value };
      } catch {
        return { issues: [{ message: "snapshot cannot be inspected safely" }] };
      }
    },
  },
};
const durableAuthoritySnapshotShapeParser = parser(durableAuthoritySnapshotStructureSchema);

/** Private bounded structural parser for the exact current Journal Authority snapshot. */
export const durableAuthoritySnapshotBoundsParser: Parser<unknown> = parser(
  boundedSnapshotValueSchema,
);

export const durableAuthoritySnapshotStructureParser: Parser<unknown> =
  durableAuthoritySnapshotBoundsParser.andThen((value) =>
    durableAuthoritySnapshotShapeParser.parse(value),
  );
