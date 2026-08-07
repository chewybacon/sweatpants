import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parser, type Parser } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { z } from "zod";

export const DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_NODES = 2_000_000;
const MAX_SNAPSHOT_TASKS = 10_000;
const MAX_SNAPSHOT_COLLECTIONS = 10_000;
const MAX_RECORDS_PER_SESSION = 100_000;
const MAX_ACTIONS_PER_TASK = 100_000;
const MAX_ATTEMPTS_PER_PULL = 10_000;
const MAX_CHILDREN_PER_OPERATION = 10_000;
const MAX_MANIFEST_ENTRIES = 10_000;

const jsonRecordSchema = z.record(z.string(), z.unknown());
const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const portableSchemaDescriptorSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    parsePortableSchemaDescriptor(value);
    return true;
  } catch {
    return false;
  }
});

const retrySafetySchema = z.union([
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
const durableOperationDescriptorSchema = z.union([
  z.strictObject({
    kind: z.literal("record"),
    key: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 128),
    retrySafety: retrySafetySchema,
  }),
  z.strictObject({
    kind: z.literal("effect"),
    name: z.string(),
    version: z.string(),
    input: jsonValueSchema,
    resolver: z.strictObject({ audience: z.string(), route: z.string().optional() }),
  }),
  z.strictObject({
    kind: z.literal("elicit"),
    key: z.string(),
    message: z.string(),
    response: portableSchemaDescriptorSchema,
    context: jsonValueSchema.optional(),
    contextContract: portableSchemaDescriptorSchema.optional(),
  }),
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
  z.strictObject({ kind: z.literal("invoke"), child: childSnapshotSchema }),
  z.strictObject({ kind: z.literal("spawn"), child: childSnapshotSchema }),
  z.strictObject({
    kind: z.literal("all"),
    children: z.array(childSnapshotSchema).max(MAX_CHILDREN_PER_OPERATION),
  }),
  z.strictObject({
    kind: z.literal("race"),
    children: z.array(childSnapshotSchema).max(MAX_CHILDREN_PER_OPERATION),
  }),
  z.strictObject({
    kind: z.literal("join"),
    handle: z.strictObject({ __durableTask: z.string(), owner: z.string() }),
  }),
]);
const programElicitDeclarationSchema = z.strictObject({
  response: portableSchemaDescriptorSchema,
  context: portableSchemaDescriptorSchema.optional(),
  contextContract: portableSchemaDescriptorSchema.optional(),
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
  capabilities: z.strictObject({
    durableEmissions: z.boolean(),
    structuredChildren: z.boolean(),
    replay: z.literal("strict"),
  }),
});
const operationOutcomeSchema = z.union([
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
const resolutionReceiptSchema = z.strictObject({
  sessionId: z.string(),
  taskId: z.string(),
  pullId: z.string(),
  resolutionOffset: z.string(),
  outcomeDigest: z.string(),
  status: z.enum(["accepted", "duplicate"]),
});
const attemptSnapshotSchema = z.strictObject({
  attemptId: z.string(),
  attemptIndex: nonNegativeIntegerSchema,
  state: z.enum(["started", "detached", "completed", "revoked", "superseded"]),
  capability: z.string(),
});
const indexedPullSchema = z.tuple([
  nonNegativeIntegerSchema,
  z.strictObject({
    pullId: z.string(),
    actionIndex: nonNegativeIntegerSchema,
    pullIndex: nonNegativeIntegerSchema,
    descriptor: durableOperationDescriptorSchema,
    descriptorDigest: z.string(),
    effectiveDescriptor: durableOperationDescriptorSchema,
    resultDescriptor: portableSchemaDescriptorSchema,
    resultSchemaDigest: z.string(),
    audience: z.string(),
    maxOutcomeBytes: nonNegativeIntegerSchema,
    attempts: z.array(attemptSnapshotSchema).max(MAX_ATTEMPTS_PER_PULL),
    revoked: z.boolean(),
    capability: z.string().optional(),
    outcome: operationOutcomeSchema.optional(),
    outcomeDigest: z.string().optional(),
    receipt: resolutionReceiptSchema.optional(),
  }),
]);
const indexedEmissionSchema = z.tuple([
  nonNegativeIntegerSchema,
  z.strictObject({
    digest: z.string(),
    receipt: z.strictObject({ offset: z.string(), eventId: z.string(), duplicate: z.boolean() }),
  }),
]);
const taskCloseSchema = z.strictObject({
  digest: z.string(),
  receipt: z.strictObject({ offset: z.string(), duplicate: z.boolean() }),
});
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
const cancellationStateSchema = z.union([
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("requested"),
    commandId: z.string(),
    reason: z.string().optional(),
    frontier: cancellationFrontierSchema,
  }),
  z.strictObject({
    type: z.literal("settling_effect"),
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
const taskSnapshotSchema = z.strictObject({
  sessionId: z.string(),
  turnId: z.string(),
  taskId: z.string(),
  manifest: durableProgramManifestSchema,
  input: jsonValueSchema,
  executionEpoch: nonNegativeIntegerSchema,
  attachmentId: z.string(),
  audience: z.string(),
  nextActionIndex: nonNegativeIntegerSchema,
  nextPullIndex: nonNegativeIntegerSchema,
  nextEmissionIndex: nonNegativeIntegerSchema,
  pullsByAction: z.array(indexedPullSchema).max(MAX_ACTIONS_PER_TASK),
  emissionsByAction: z.array(indexedEmissionSchema).max(MAX_ACTIONS_PER_TASK),
  status: z.enum(["active", "closed", "cancelled", "orphaned"]),
  cancellation: cancellationStateSchema,
  close: taskCloseSchema.optional(),
  parentTaskId: z.string().optional(),
  parentPullId: z.string().optional(),
  emissionPolicy: emissionPolicySnapshotSchema.optional(),
  acceptedEmissionCount: nonNegativeIntegerSchema.optional(),
  cumulativeEmissionBytes: nonNegativeIntegerSchema.optional(),
  catalog: jsonRecordSchema.optional(),
  catalogDigest: z.string().optional(),
  route: z.union([z.string(), jsonRecordSchema]).optional(),
});
const semanticPayloadSchema = z.union([
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
const activationLeaseSchema = z.tuple([
  z.string(),
  z.strictObject({
    sessionId: z.string(),
    ownerId: z.string(),
    epoch: nonNegativeIntegerSchema,
    expiresAtMs: nonNegativeIntegerSchema,
    leaseDurationMs: nonNegativeIntegerSchema,
    claimedTaskRevision: nonNegativeIntegerSchema,
    claimedHeadDigest: z.string(),
    restoreNonce: z.string(),
  }),
]);
const durableAuthoritySnapshotStructureSchema = z.strictObject({
  version: z.literal(4),
  tasks: z.array(taskSnapshotSchema).max(MAX_SNAPSHOT_TASKS),
  records: z.array(recordCollectionSchema).max(MAX_SNAPSHOT_COLLECTIONS),
  runnable: z.array(z.string()).max(MAX_SNAPSHOT_TASKS),
  nonce: nonNegativeIntegerSchema,
  activationLeases: z.array(activationLeaseSchema).max(MAX_SNAPSHOT_TASKS),
  lastActivationEpochBySession: z
    .array(z.tuple([z.string(), nonNegativeIntegerSchema]))
    .max(MAX_SNAPSHOT_TASKS),
  taskRevisions: z.array(z.tuple([z.string(), nonNegativeIntegerSchema])).max(MAX_SNAPSHOT_TASKS),
  restoreNonces: z.array(z.tuple([z.string(), z.string()])).max(MAX_SNAPSHOT_TASKS),
  restoreFrontierDigests: z.array(z.tuple([z.string(), z.string()])).max(MAX_SNAPSHOT_TASKS),
  consecutiveRestoreStales: z
    .array(z.tuple([z.string(), nonNegativeIntegerSchema]))
    .max(MAX_SNAPSHOT_TASKS),
  activationNotBeforeMs: z
    .array(z.tuple([z.string(), nonNegativeIntegerSchema]))
    .max(MAX_SNAPSHOT_TASKS),
});

const boundedSnapshotValueSchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "sweatpants",
    validate(value) {
      try {
        const seen = new WeakSet();
        const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
        let nodes = 0;
        while (pending.length > 0) {
          const current = pending.pop()!;
          nodes += 1;
          if (nodes > MAX_SNAPSHOT_NODES) {
            return { issues: [{ message: "snapshot node count exceeds limit" }] };
          }
          if (current.depth > MAX_SNAPSHOT_DEPTH) {
            return { issues: [{ message: "snapshot depth exceeds limit" }] };
          }
          if (current.value === null || typeof current.value !== "object") {
            continue;
          }
          if (seen.has(current.value)) {
            return { issues: [{ message: "snapshot contains a cycle" }] };
          }
          seen.add(current.value);
          for (const child of Object.values(current.value)) {
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
export const durableAuthoritySnapshotStructureParser: Parser<unknown> = parser(
  boundedSnapshotValueSchema,
).andThen((value) => durableAuthoritySnapshotShapeParser.parse(value));
