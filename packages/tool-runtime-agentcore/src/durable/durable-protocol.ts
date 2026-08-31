import {
  CrankError,
  type AttachProgramRequest,
  type ProgramAttachment,
  type ProgramCommand,
  type ProgramShutdownReason,
  type ProgramStep,
  type ReplayEmissionEntry,
  type ReplayEntry,
  type ReplayOperationEntry,
} from "@sweatpants/durable-execution";
import {
  canonicalJson,
  canonicalSnapshot,
  failure,
  parser,
  sha256,
  success,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import { z } from "zod";

import { AGENTCORE_DURABLE_PROTOCOL_VERSION } from "./durable-placement.ts";

export const AGENTCORE_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const AGENTCORE_MAX_ERROR_TEXT_BYTES = 4 * 1024;

export type AgentCoreDurableProgramErrorCode =
  | "placement_unavailable"
  | "program_version_unavailable"
  | "schema_version_unavailable"
  | "activation_busy"
  | "stale_activation"
  | "restore_stale"
  | "replay_diverged"
  | "history_not_exhausted"
  | "protocol_version_unsupported"
  | "program_protocol_error"
  | "sandbox_task_mismatch"
  | "payload_too_large"
  | "agentcore_auth_failed"
  | "agentcore_transport_lost"
  | "agentcore_session_stopped"
  | "agentcore_runtime_rejected";

export interface AgentCoreProgramEnvelope<TType extends string, TPayload> {
  readonly protocolVersion: 1;
  readonly type: TType;
  readonly releaseId: string;
  readonly taskId: string;
  readonly activationEpoch: number;
  readonly attachmentId?: string;
  readonly actionIndex?: number;
  readonly payload: TPayload;
}

export type HostProgramMessage =
  | AgentCoreProgramEnvelope<
      "restore_begin",
      {
        attach: AttachProgramRequest;
        programInputDigest: string;
        replayedThroughActionIndex: number;
        replayChainSeed: string;
      }
    >
  | AgentCoreProgramEnvelope<"replay_operation", ReplayOperationEntry>
  | AgentCoreProgramEnvelope<"replay_emission", ReplayEmissionEntry>
  | AgentCoreProgramEnvelope<"replay_end", { entryCount: number; replayChainDigest: string }>
  | AgentCoreProgramEnvelope<"command", { command: ProgramCommand }>
  | AgentCoreProgramEnvelope<"shutdown", { reason: ProgramShutdownReason }>;

export type RuntimeProgramMessage =
  | AgentCoreProgramEnvelope<
      "restore_ready",
      {
        attachment: Omit<ProgramAttachment, "handle">;
        computeGeneration: string;
      }
    >
  | AgentCoreProgramEnvelope<
      "frontier",
      {
        step: ProgramStep;
        replayedThroughActionIndex: number;
        replayChainDigest: string;
        frontierDigest: string;
      }
    >
  | AgentCoreProgramEnvelope<"step", { step: ProgramStep }>
  | AgentCoreProgramEnvelope<"shutdown_complete", Record<string, never>>
  | AgentCoreProgramEnvelope<
      "rejected",
      {
        code: AgentCoreDurableProgramErrorCode;
        message: string;
      }
    >;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonemptyStringSchema = z.string().min(1);
const envelopeIdentifierSchema = nonemptyStringSchema.max(4_096);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const replayPositionSchema = z.number().int().min(-1);
const pinnedProgramSchema = z.strictObject({
  id: nonemptyStringSchema,
  version: nonemptyStringSchema,
  digest: digestSchema,
});
const affinitySchema = z.strictObject({
  kind: z.enum(["invocation", "conversation", "workspace"]),
  key: nonemptyStringSchema,
});
const retrySafetySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("repeatable") }),
  z.strictObject({ mode: z.literal("unsafe") }),
  z.strictObject({ mode: z.literal("idempotent"), mechanism: z.enum(["pull_id_key", "inherent"]) }),
]);
const childSchema = z.strictObject({
  id: nonemptyStringSchema,
  version: nonemptyStringSchema,
  digest: digestSchema,
  input: z.json(),
});
const resolverSchema = z.strictObject({
  audience: nonemptyStringSchema,
  route: nonemptyStringSchema.optional(),
});
const operationDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("record"),
    key: z.string().min(1).max(128),
    retrySafety: retrySafetySchema,
  }),
  z.strictObject({
    kind: z.literal("effect"),
    name: nonemptyStringSchema,
    version: nonemptyStringSchema,
    input: z.json(),
    resolver: resolverSchema,
  }),
  z.strictObject({
    kind: z.literal("elicit"),
    key: nonemptyStringSchema,
    message: z.string(),
    response: z.json(),
    context: z.json().optional(),
    contextContract: z.json().optional(),
    binding: z.strictObject({ id: digestSchema }).optional(),
  }),
  z
    .strictObject({
      kind: z.literal("wait"),
      key: nonemptyStringSchema,
      notBefore: z.string().optional(),
      durationMs: nonNegativeIntegerSchema.optional(),
    })
    .refine((value) => (value.notBefore === undefined) !== (value.durationMs === undefined)),
  z.strictObject({ kind: z.literal("invoke"), child: childSchema }),
  z.strictObject({ kind: z.literal("spawn"), child: childSchema }),
  z.strictObject({
    kind: z.literal("sample"),
    input: z.json(),
  }),
  z.strictObject({
    kind: z.literal("join"),
    handle: z.strictObject({
      __durableTask: nonemptyStringSchema,
      owner: nonemptyStringSchema,
    }),
  }),
  z.strictObject({ kind: z.enum(["all", "race"]), children: z.array(childSchema) }),
]);
const applicationErrorSchema = z.strictObject({
  code: nonemptyStringSchema,
  message: z.string(),
  details: z.json().optional(),
});
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.json() }),
  z.strictObject({ status: z.literal("error"), error: applicationErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), partial: z.json().optional() }),
]);
const receiptSchema = z.strictObject({
  sessionId: nonemptyStringSchema,
  taskId: nonemptyStringSchema,
  pullId: nonemptyStringSchema,
  resolutionOffset: nonemptyStringSchema,
  outcomeDigest: digestSchema,
  status: z.enum(["accepted", "duplicate"]),
});
const placementSchema = z.strictObject({
  journal: z.strictObject({ id: nonemptyStringSchema, incarnation: nonemptyStringSchema }),
  program: pinnedProgramSchema,
  route: z.json(),
  driverKind: nonemptyStringSchema,
});
const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), input: z.json() }),
  z.strictObject({
    type: z.literal("resume"),
    actionIndex: nonNegativeIntegerSchema,
    outcome: outcomeSchema,
    receipt: receiptSchema,
    replayed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("authorize"),
    actionIndex: nonNegativeIntegerSchema,
    pullId: nonemptyStringSchema,
    attemptId: nonemptyStringSchema,
    resolutionCapability: nonemptyStringSchema,
    descriptor: z
      .union([operationDescriptorSchema.options[0], operationDescriptorSchema.options[1]])
      .optional(),
    effectContractDigest: digestSchema.optional(),
    placement: placementSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("ack_emission"),
    actionIndex: nonNegativeIntegerSchema,
    offset: nonemptyStringSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), reason: z.string().optional() }),
]);
const stepSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("operation"),
    actionIndex: nonNegativeIntegerSchema,
    descriptor: operationDescriptorSchema,
    authorizedOutcome: outcomeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("emission"),
    actionIndex: nonNegativeIntegerSchema,
    descriptor: z.strictObject({ eventType: nonemptyStringSchema, payload: z.json() }),
  }),
  z.strictObject({
    type: z.literal("completed"),
    actionIndex: nonNegativeIntegerSchema,
    value: z.json(),
  }),
  z.strictObject({
    type: z.literal("failed"),
    actionIndex: nonNegativeIntegerSchema,
    error: applicationErrorSchema,
  }),
]);
const replayOperationSchema = z.strictObject({
  type: z.literal("operation"),
  actionIndex: nonNegativeIntegerSchema,
  descriptorKind: nonemptyStringSchema,
  descriptorDigest: digestSchema,
  previousEntryDigest: digestSchema,
  entryDigest: digestSchema,
  outcome: outcomeSchema,
  receipt: receiptSchema,
});
const replayEmissionSchema = z.strictObject({
  type: z.literal("emission"),
  actionIndex: nonNegativeIntegerSchema,
  descriptorKind: nonemptyStringSchema,
  descriptorDigest: digestSchema,
  previousEntryDigest: digestSchema,
  entryDigest: digestSchema,
  offset: nonemptyStringSchema,
});
const attachSchema = z.strictObject({
  sessionId: nonemptyStringSchema,
  taskId: nonemptyStringSchema,
  program: pinnedProgramSchema,
  input: z.json(),
  route: z.json(),
  executionEpoch: nonNegativeIntegerSchema,
  affinity: affinitySchema,
});
const attachmentSchema = z.strictObject({
  attachmentId: nonemptyStringSchema,
  taskId: nonemptyStringSchema,
  driverKind: nonemptyStringSchema,
  route: z.json(),
  executionEpoch: nonNegativeIntegerSchema,
});
const envelopeBaseShape = {
  protocolVersion: z.number().int(),
  releaseId: envelopeIdentifierSchema,
  taskId: envelopeIdentifierSchema,
  activationEpoch: nonNegativeIntegerSchema,
  attachmentId: envelopeIdentifierSchema.optional(),
  actionIndex: nonNegativeIntegerSchema.optional(),
};
const hostEnvelopeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("restore_begin"),
    payload: z.strictObject({
      attach: attachSchema,
      programInputDigest: nonemptyStringSchema,
      replayedThroughActionIndex: replayPositionSchema,
      replayChainSeed: digestSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_operation"),
    attachmentId: envelopeIdentifierSchema,
    actionIndex: nonNegativeIntegerSchema,
    payload: replayOperationSchema,
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_emission"),
    attachmentId: envelopeIdentifierSchema,
    actionIndex: nonNegativeIntegerSchema,
    payload: replayEmissionSchema,
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_end"),
    attachmentId: envelopeIdentifierSchema,
    payload: z.strictObject({
      entryCount: nonNegativeIntegerSchema,
      replayChainDigest: digestSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("command"),
    attachmentId: envelopeIdentifierSchema,
    payload: z.strictObject({ command: commandSchema }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("shutdown"),
    attachmentId: envelopeIdentifierSchema,
    payload: z.strictObject({
      reason: z.enum([
        "parked",
        "completed",
        "failed",
        "cancelled",
        "transport_lost",
        "scope_exit",
      ]),
    }),
  }),
]);
const runtimeEnvelopeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("restore_ready"),
    payload: z.strictObject({
      attachment: attachmentSchema,
      computeGeneration: nonemptyStringSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("frontier"),
    attachmentId: envelopeIdentifierSchema,
    payload: z.strictObject({
      step: stepSchema,
      replayedThroughActionIndex: replayPositionSchema,
      replayChainDigest: digestSchema,
      frontierDigest: digestSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("step"),
    attachmentId: envelopeIdentifierSchema,
    actionIndex: nonNegativeIntegerSchema,
    payload: z.strictObject({ step: stepSchema }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("shutdown_complete"),
    attachmentId: envelopeIdentifierSchema,
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("rejected"),
    payload: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);

const errorCodes = new Set<AgentCoreDurableProgramErrorCode>([
  "placement_unavailable",
  "program_version_unavailable",
  "schema_version_unavailable",
  "activation_busy",
  "stale_activation",
  "restore_stale",
  "replay_diverged",
  "history_not_exhausted",
  "protocol_version_unsupported",
  "program_protocol_error",
  "sandbox_task_mismatch",
  "payload_too_large",
  "agentcore_auth_failed",
  "agentcore_transport_lost",
  "agentcore_session_stopped",
  "agentcore_runtime_rejected",
]);

export const hostProgramMessageParser: Parser<HostProgramMessage> =
  parser(hostEnvelopeSchema).andThen(verifyHostProgramMessage);
export const runtimeProgramMessageParser: Parser<RuntimeProgramMessage> = parser(
  runtimeEnvelopeSchema,
).andThen(verifyRuntimeProgramMessage);

export function encodeAgentCoreProgramMessage(
  message: HostProgramMessage | RuntimeProgramMessage,
): string {
  const encoded = canonicalJson(message);
  if (new TextEncoder().encode(encoded).byteLength > AGENTCORE_MAX_FRAME_BYTES) {
    throw new CrankError("payload_too_large", "AgentCore protocol frame exceeds 2 MiB");
  }
  return encoded;
}

export function parseHostProgramMessage(frame: string | Uint8Array): HostProgramMessage {
  return parseMessage(frame, hostProgramMessageParser);
}

export function parseRuntimeProgramMessage(frame: string | Uint8Array): RuntimeProgramMessage {
  return parseMessage(frame, runtimeProgramMessageParser);
}

function parseMessage<T>(frame: string | Uint8Array, messageParser: Parser<T>): T {
  const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  if (bytes.byteLength > AGENTCORE_MAX_FRAME_BYTES) {
    throw protocol("payload_too_large", "Frame exceeds 2 MiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame),
    );
  } catch (error) {
    throw protocol("program_protocol_error", "Malformed canonical JSON", error);
  }
  const parsed = messageParser.parse(decoded);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    if (issue?.code === "protocol_version_unsupported") {
      throw protocol("protocol_version_unsupported", issue.message);
    }
    throw protocol(
      "program_protocol_error",
      issue?.code === "unrecognized_keys"
        ? "Envelope fields are not closed"
        : (issue?.message ?? "Envelope structure is invalid"),
    );
  }
  return parsed.value;
}

function verifyHostProgramMessage(value: unknown): ParseResult<HostProgramMessage> {
  const envelope = value as HostProgramMessage;
  const common = verifyProtocolVersion(envelope.protocolVersion);
  if (!common.ok) {
    return common;
  }
  switch (envelope.type) {
    case "restore_begin":
      if (
        envelope.payload.attach.taskId !== envelope.taskId ||
        envelope.payload.attach.executionEpoch !== envelope.activationEpoch
      ) {
        return invalidProtocolPayload();
      }
      break;
    case "replay_operation":
    case "replay_emission":
      if (envelope.actionIndex !== envelope.payload.actionIndex) {
        return invalidProtocolPayload();
      }
      break;
    case "command":
      if (
        (envelope.payload.command.type === "resume" ||
          envelope.payload.command.type === "authorize" ||
          envelope.payload.command.type === "ack_emission") &&
        envelope.actionIndex !== envelope.payload.command.actionIndex
      ) {
        return invalidProtocolPayload();
      }
      break;
    case "replay_end":
    case "shutdown":
      break;
  }
  return success(canonicalSnapshot(envelope).value);
}

function verifyRuntimeProgramMessage(value: unknown): ParseResult<RuntimeProgramMessage> {
  const envelope = value as RuntimeProgramMessage;
  const common = verifyProtocolVersion(envelope.protocolVersion);
  if (!common.ok) {
    return common;
  }
  switch (envelope.type) {
    case "step":
      if (envelope.actionIndex !== envelope.payload.step.actionIndex) {
        return invalidProtocolPayload();
      }
      break;
    case "rejected":
      if (
        !errorCodes.has(envelope.payload.code) ||
        new TextEncoder().encode(envelope.payload.message).byteLength >
          AGENTCORE_MAX_ERROR_TEXT_BYTES
      ) {
        return invalidProtocolPayload();
      }
      break;
    case "restore_ready":
    case "frontier":
    case "shutdown_complete":
      break;
  }
  return success(canonicalSnapshot(envelope).value);
}

function verifyProtocolVersion(version: number): ParseResult<never> | { readonly ok: true } {
  if (version !== AGENTCORE_DURABLE_PROTOCOL_VERSION) {
    return failure({
      path: ["protocolVersion"],
      message: "Unsupported protocol version",
      code: "protocol_version_unsupported",
    });
  }
  return { ok: true };
}

function invalidProtocolPayload(): ParseResult<never> {
  return failure({
    path: [],
    message: "Invalid protocol payload",
    code: "program_protocol_error",
  });
}

export interface ReplayChainSeedInput {
  readonly releaseId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly activationEpoch: number;
  readonly journalHeadDigest: string;
  readonly restoreNonce: string;
}

export function computeReplayChainSeed(input: ReplayChainSeedInput): string {
  return sha256(
    canonicalJson({ domain: "sweatpants.agentcore.replay.v1", protocolVersion: 1, ...input }),
  );
}

export type UnlinkedReplayEntry = ReplayEntry extends infer Entry
  ? Entry extends ReplayEntry
    ? Omit<Entry, "previousEntryDigest" | "entryDigest">
    : never
  : never;

export function linkReplayEntry(
  seed: string,
  previousEntryDigest: string,
  entry: UnlinkedReplayEntry,
): ReplayEntry {
  if (!digest(seed) || !digest(previousEntryDigest)) {
    throw protocol("program_protocol_error", "Invalid replay chain digest");
  }
  const entryWithoutEntryDigest = { ...entry, previousEntryDigest };
  const entryDigest = sha256(
    canonicalJson({ replayChainSeed: seed, previousEntryDigest, entryWithoutEntryDigest }),
  );
  return { ...entryWithoutEntryDigest, entryDigest } as ReplayEntry;
}

export function verifyReplayEntry(
  seed: string,
  previousEntryDigest: string,
  entry: ReplayEntry,
): boolean {
  const { entryDigest, previousEntryDigest: claimedPrevious, ...body } = entry;
  if (claimedPrevious !== previousEntryDigest) {
    return false;
  }
  return linkReplayEntry(seed, previousEntryDigest, body).entryDigest === entryDigest;
}

export interface FrontierDigestInput {
  readonly releaseId: string;
  readonly taskId: string;
  readonly activationEpoch: number;
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
  readonly step: ProgramStep;
}

export function computeFrontierDigest(input: FrontierDigestInput): string {
  return sha256(
    canonicalJson({ domain: "sweatpants.agentcore.frontier.v1", protocolVersion: 1, ...input }),
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function protocol(
  code: AgentCoreDurableProgramErrorCode,
  message: string,
  cause?: unknown,
): CrankError {
  return new CrankError(code, message, undefined, { cause });
}
