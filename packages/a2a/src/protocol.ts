import { CrankError } from "@sweatpants/durable-execution";
import { z } from "zod";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  failure,
  parser,
  sha256,
  success,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";

import type { Json } from "@sweatpants/foundation";
import type {
  PinnedProgram,
  ProgramCommand,
  ProgramStep,
  ReplayEntry,
} from "@sweatpants/durable-execution";
import { assertBoundedA2AJson } from "./json-bounds.ts";
import {
  A2A_MAX_ERROR_TEXT_BYTES,
  A2A_MAX_FRAME_BYTES,
  A2A_PROTOCOL_VERSION,
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type A2AProgramErrorCode,
  type ClientProgramMessageV1,
  type ExecutorHelloV1,
  type ProgramEnvelopeV1,
  type ServerProgramMessageV1,
  type WireProgramCommandV1,
} from "./types.ts";

const encoder = new TextEncoder();
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,255}$/;
const protocolIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,255}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const programSchema = z
  .object({
    id: protocolIdentifierSchema,
    version: protocolIdentifierSchema,
    digest: digestSchema,
  })
  .strict();
const executorHelloSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.number().int(),
    extensionUri: z.string().max(512),
    executorId: protocolIdentifierSchema,
    maxFrameBytes: z.literal(A2A_MAX_FRAME_BYTES),
    capabilities: z.object({ streamedRestore: z.boolean() }).strict(),
  })
  .strict();

const affinitySchema = z.strictObject({
  kind: z.enum(["invocation", "conversation", "workspace"]),
  key: protocolIdentifierSchema,
});
const retrySafetySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("repeatable") }),
  z.strictObject({ mode: z.literal("unsafe") }),
  z.strictObject({ mode: z.literal("idempotent"), mechanism: z.enum(["pull_id_key", "inherent"]) }),
]);
const childSchema = z.strictObject({
  id: protocolIdentifierSchema,
  version: protocolIdentifierSchema,
  digest: digestSchema,
  input: z.json(),
});
const resolverSchema = z.strictObject({
  audience: protocolIdentifierSchema,
  route: protocolIdentifierSchema.optional(),
});
const operationDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("record"),
    key: z.string().min(1).max(128),
    retrySafety: retrySafetySchema,
  }),
  z.strictObject({
    kind: z.literal("effect"),
    name: protocolIdentifierSchema,
    version: protocolIdentifierSchema,
    input: z.json(),
    resolver: resolverSchema,
  }),
  z.strictObject({
    kind: z.literal("elicit"),
    key: protocolIdentifierSchema,
    message: z.string(),
    response: z.json(),
    context: z.json().optional(),
    contextContract: z.json().optional(),
  }),
  z
    .strictObject({
      kind: z.literal("wait"),
      key: protocolIdentifierSchema,
      notBefore: z.string().optional(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .refine((value) => (value.notBefore === undefined) !== (value.durationMs === undefined)),
  z.strictObject({ kind: z.literal("invoke"), child: childSchema }),
  z.strictObject({ kind: z.literal("spawn"), child: childSchema }),
  z.strictObject({ kind: z.literal("join"), handle: z.json() }),
  z.strictObject({ kind: z.enum(["all", "race"]), children: z.array(childSchema) }),
]);
const applicationErrorSchema = z.strictObject({
  code: protocolIdentifierSchema,
  message: z.string(),
  details: z.json().optional(),
});
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.json() }),
  z.strictObject({ status: z.literal("error"), error: applicationErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), partial: z.json().optional() }),
]);
const receiptSchema = z.strictObject({
  sessionId: protocolIdentifierSchema,
  taskId: protocolIdentifierSchema,
  pullId: protocolIdentifierSchema,
  resolutionOffset: protocolIdentifierSchema,
  outcomeDigest: digestSchema,
  status: z.enum(["accepted", "duplicate"]),
});
const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), input: z.json() }),
  z.strictObject({
    type: z.literal("resume"),
    actionIndex: z.number().int().nonnegative(),
    outcome: outcomeSchema,
    receipt: receiptSchema,
    replayed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("authorize"),
    actionIndex: z.number().int().nonnegative(),
    pullId: protocolIdentifierSchema,
    attemptId: protocolIdentifierSchema,
    descriptor: operationDescriptorSchema.optional(),
    effectContractDigest: digestSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("ack_emission"),
    actionIndex: z.number().int().nonnegative(),
    offset: protocolIdentifierSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), reason: z.string().optional() }),
]);
const stepSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("operation"),
    actionIndex: z.number().int().nonnegative(),
    descriptor: operationDescriptorSchema,
    authorizedOutcome: outcomeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("emission"),
    actionIndex: z.number().int().nonnegative(),
    descriptor: z.strictObject({ eventType: protocolIdentifierSchema, payload: z.json() }),
  }),
  z.strictObject({
    type: z.literal("completed"),
    actionIndex: z.number().int().nonnegative(),
    value: z.json(),
  }),
  z.strictObject({
    type: z.literal("failed"),
    actionIndex: z.number().int().nonnegative(),
    error: applicationErrorSchema,
  }),
]);
const replayOperationSchema = z.strictObject({
  type: z.literal("operation"),
  actionIndex: z.number().int().nonnegative(),
  descriptorKind: protocolIdentifierSchema,
  descriptorDigest: digestSchema,
  previousEntryDigest: digestSchema,
  entryDigest: digestSchema,
  outcome: outcomeSchema,
  receipt: receiptSchema,
});
const replayEmissionSchema = z.strictObject({
  type: z.literal("emission"),
  actionIndex: z.number().int().nonnegative(),
  descriptorKind: protocolIdentifierSchema,
  descriptorDigest: digestSchema,
  previousEntryDigest: digestSchema,
  entryDigest: digestSchema,
  offset: protocolIdentifierSchema,
});
const envelopeBaseShape = {
  protocolVersion: z.number().int(),
  extensionUri: z.string().max(512),
  executionId: protocolIdentifierSchema,
  program: programSchema,
  executionEpoch: z.number().int().positive(),
  attachmentId: protocolIdentifierSchema.optional(),
  actionIndex: z.number().int().nonnegative().optional(),
  commandId: protocolIdentifierSchema.optional(),
};
const clientEnvelopeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("attach_begin"),
    payload: z.strictObject({
      input: z.json(),
      inputDigest: digestSchema,
      affinity: affinitySchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("command"),
    payload: z.strictObject({ command: commandSchema }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("shutdown"),
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
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("restore_begin"),
    payload: z.strictObject({
      input: z.json(),
      inputDigest: digestSchema,
      replayedThroughActionIndex: z.number().int().min(-1),
      replayChainSeed: digestSchema,
      affinity: affinitySchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_operation"),
    payload: replayOperationSchema,
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_emission"),
    payload: replayEmissionSchema,
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("replay_end"),
    payload: z.strictObject({
      entryCount: z.number().int().nonnegative(),
      replayChainDigest: digestSchema,
    }),
  }),
]);
const serverEnvelopeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("attachment_ready"),
    payload: z.strictObject({
      attachmentId: protocolIdentifierSchema,
      computeGeneration: protocolIdentifierSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("step"),
    payload: z.strictObject({ step: stepSchema }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("shutdown_complete"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("restore_ready"),
    payload: z.strictObject({
      attachmentId: protocolIdentifierSchema,
      computeGeneration: protocolIdentifierSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("frontier"),
    payload: z.strictObject({
      step: stepSchema,
      replayedThroughActionIndex: z.number().int().min(-1),
      replayChainDigest: digestSchema,
      frontierDigest: digestSchema,
    }),
  }),
  z.strictObject({
    ...envelopeBaseShape,
    type: z.literal("rejected"),
    payload: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);

const clientEnvelopeParser = parser(clientEnvelopeSchema);
const serverEnvelopeParser = parser(serverEnvelopeSchema);
const executorHelloParser = parser(executorHelloSchema);

export const clientProgramMessageParser = clientEnvelopeParser.andThen((value) =>
  verifyEnvelopeResult(value, clientTypes, assertA2AClientPayload),
) as Parser<ClientProgramMessageV1>;
export const serverProgramMessageParser = serverEnvelopeParser.andThen((value) =>
  verifyEnvelopeResult(value, serverTypes, assertA2AServerPayload),
) as Parser<ServerProgramMessageV1>;

const clientTypes = new Set([
  "attach_begin",
  "command",
  "shutdown",
  "restore_begin",
  "replay_operation",
  "replay_emission",
  "replay_end",
]);
const serverTypes = new Set([
  "attachment_ready",
  "step",
  "shutdown_complete",
  "restore_ready",
  "frontier",
  "rejected",
]);
const errorCodes = new Set<A2AProgramErrorCode>([
  "agent_card_invalid",
  "unsafe_url",
  "authentication_failed",
  "authorization_denied",
  "extension_not_advertised",
  "extension_not_activated",
  "extension_echo_mismatch",
  "protocol_version_unsupported",
  "manifest_not_found",
  "manifest_mismatch",
  "program_version_unavailable",
  "schema_version_unavailable",
  "effect_handler_missing",
  "effect_contract_mismatch",
  "identity_mismatch",
  "stale_activation",
  "idempotency_conflict",
  "payload_too_large",
  "replay_diverged",
  "history_not_exhausted",
  "program_protocol_error",
  "deadline_exceeded",
  "transport_lost",
]);

export function encodeA2AProgramMessage(
  message: ExecutorHelloV1 | ClientProgramMessageV1 | ServerProgramMessageV1,
): string {
  const encoded = canonicalJson(message);
  if (encoder.encode(encoded).byteLength > A2A_MAX_FRAME_BYTES) {
    throw a2aError("payload_too_large", "A2A protocol frame exceeds 2 MiB");
  }
  return encoded;
}

export function parseExecutorHello(frame: string | Uint8Array): ExecutorHelloV1 {
  const parsed = executorHelloParser.parse(parseCanonicalFrame(frame));
  if (!parsed.ok) {
    throw a2aError("extension_echo_mismatch", "Expected a closed executor hello frame");
  }
  if (
    parsed.value.protocolVersion !== A2A_PROTOCOL_VERSION ||
    parsed.value.extensionUri !== CALLER_AUTHORITATIVE_EXTENSION_URI
  ) {
    throw a2aError("extension_echo_mismatch", "Executor extension identity does not match");
  }
  return canonicalSnapshot(parsed.value).value as unknown as ExecutorHelloV1;
}

export function parseClientProgramMessage(frame: string | Uint8Array): ClientProgramMessageV1 {
  return parseEnvelope(frame, clientTypes) as ClientProgramMessageV1;
}

export function parseServerProgramMessage(frame: string | Uint8Array): ServerProgramMessageV1 {
  return parseEnvelope(frame, serverTypes) as ServerProgramMessageV1;
}

/**
 * Derives one logical command identity. Cancel intentionally has no reason in
 * its identity: cancellation is one-shot, so callers MUST keep the first
 * command's reason stable; changed content is an idempotency conflict.
 */
export function computeA2ACommandId(input: {
  executionId: string;
  executionEpoch: number;
  attachmentId: string;
  command: ProgramCommand | WireProgramCommandV1;
}): string {
  const actionIndex = "actionIndex" in input.command ? input.command.actionIndex : undefined;
  return `cmd_${sha256(
    canonicalJson({
      domain: "sweatpants.a2a.command.v1",
      executionId: input.executionId,
      executionEpoch: input.executionEpoch,
      attachmentId: input.attachmentId,
      commandType: input.command.type,
      ...(actionIndex !== undefined ? { actionIndex } : {}),
    }),
  ).slice(0, 40)}`;
}

export function projectProgramCommand(command: ProgramCommand): WireProgramCommandV1 {
  if (command.type === "authorize") {
    return {
      type: command.type,
      actionIndex: command.actionIndex,
      pullId: command.pullId,
      attemptId: command.attemptId,
      ...(command.descriptor ? { descriptor: command.descriptor } : {}),
      ...(command.effectContractDigest
        ? { effectContractDigest: command.effectContractDigest }
        : {}),
    };
  }
  return canonicalSnapshot(command).value;
}

export function computeA2AReplayChainSeed(input: {
  executionId: string;
  program: PinnedProgram;
  executionEpoch: number;
  inputDigest: string;
}): string {
  return sha256(
    canonicalJson({ domain: "sweatpants.a2a.replay.v1", protocolVersion: 1, ...input }),
  );
}

export function linkA2AReplayEntry(
  seed: string,
  previousEntryDigest: string,
  entry: Omit<ReplayEntry, "previousEntryDigest" | "entryDigest">,
): ReplayEntry {
  requireDigest(seed);
  requireDigest(previousEntryDigest);
  const body = { ...entry, previousEntryDigest };
  return {
    ...body,
    entryDigest: sha256(
      canonicalJson({
        replayChainSeed: seed,
        previousEntryDigest,
        entryWithoutEntryDigest: body,
      }),
    ),
  } as ReplayEntry;
}

export function verifyA2AReplayEntry(
  seed: string,
  previousEntryDigest: string,
  entry: ReplayEntry,
): boolean {
  const { entryDigest, previousEntryDigest: claimed, ...body } = entry;
  return (
    claimed === previousEntryDigest &&
    linkA2AReplayEntry(seed, previousEntryDigest, body).entryDigest === entryDigest
  );
}

export function computeA2AFrontierDigest(input: {
  executionId: string;
  program: PinnedProgram;
  executionEpoch: number;
  attachmentId: string;
  replayedThroughActionIndex: number;
  replayChainDigest: string;
  step: ProgramStep;
}): string {
  return sha256(
    canonicalJson({ domain: "sweatpants.a2a.frontier.v1", protocolVersion: 1, ...input }),
  );
}

export function assertEnvelopeIdentity(
  message: ProgramEnvelopeV1<string, unknown>,
  expected: {
    executionId: string;
    program: PinnedProgram;
    executionEpoch: number;
    attachmentId?: string;
  },
): void {
  if (
    message.executionId !== expected.executionId ||
    message.executionEpoch !== expected.executionEpoch ||
    canonicalJson(message.program) !== canonicalJson(expected.program) ||
    (expected.attachmentId !== undefined && message.attachmentId !== expected.attachmentId)
  ) {
    throw a2aError("identity_mismatch", "A2A protocol identity mismatch");
  }
}

function parseEnvelope(
  frame: string | Uint8Array,
  allowedTypes: ReadonlySet<string>,
): ClientProgramMessageV1 | ServerProgramMessageV1 {
  const value = parseCanonicalFrame(frame);
  const parsed =
    allowedTypes === clientTypes
      ? clientProgramMessageParser.parse(value)
      : serverProgramMessageParser.parse(value);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    const code =
      issue?.code && errorCodes.has(issue.code as A2AProgramErrorCode)
        ? (issue.code as A2AProgramErrorCode)
        : "program_protocol_error";
    throw a2aError(code, issue?.message ?? "Invalid A2A program protocol payload");
  }
  return parsed.value;
}

function verifyEnvelopeResult(
  value: unknown,
  allowedTypes: ReadonlySet<string>,
  parsePayload: (type: string, envelope: Record<string, Json>) => void,
): ParseResult<ClientProgramMessageV1 | ServerProgramMessageV1> {
  try {
    const envelope = value as Record<string, Json>;
    if (envelope["protocolVersion"] !== 1) {
      throw a2aError("protocol_version_unsupported", "Unsupported A2A program protocol version");
    }
    if (envelope["extensionUri"] !== CALLER_AUTHORITATIVE_EXTENSION_URI) {
      throw a2aError("extension_echo_mismatch", "A2A extension identity mismatch");
    }
    const type = envelope["type"];
    if (typeof type !== "string" || !allowedTypes.has(type)) {
      throw protocol("Unknown message type");
    }
    parsePayload(type, envelope);
    return success(
      canonicalSnapshot(envelope).value as unknown as
        | ClientProgramMessageV1
        | ServerProgramMessageV1,
    );
  } catch (error) {
    if (error instanceof CrankError) {
      return failure({ path: [], message: error.message, code: error.code });
    }
    throw error;
  }
}

function assertA2AClientPayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "attach_begin":
    case "restore_begin":
      requireNoScope(envelope);
      break;
    case "command":
      requireAttachmentAndCommand(envelope);
      assertA2ACommand(payload["command"] as Record<string, Json>, envelope);
      break;
    case "shutdown":
      requireAttachmentAndCommand(envelope);
      break;
    case "replay_operation":
    case "replay_emission":
      requireAttachment(envelope);
      if (envelope["commandId"] !== undefined) fail();
      assertA2AReplayEntry(payload, type === "replay_operation" ? "operation" : "emission");
      if (envelope["actionIndex"] !== payload["actionIndex"]) fail();
      break;
    case "replay_end":
      requireAttachment(envelope);
      if (envelope["actionIndex"] !== undefined || envelope["commandId"] !== undefined) fail();
      break;
    default:
      fail();
  }
}

function assertA2AServerPayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "attachment_ready":
    case "restore_ready":
      if (
        envelope["attachmentId"] !== payload["attachmentId"] ||
        envelope["actionIndex"] !== undefined ||
        envelope["commandId"] !== undefined
      )
        fail();
      break;
    case "step":
      requireAttachmentAndCommand(envelope);
      assertA2AStep(payload["step"]);
      if (envelope["actionIndex"] !== (payload["step"] as Record<string, Json>)["actionIndex"]) {
        fail();
      }
      break;
    case "shutdown_complete":
      requireAttachmentAndCommand(envelope);
      if (envelope["actionIndex"] !== undefined) fail();
      break;
    case "frontier":
      requireAttachment(envelope);
      if (envelope["commandId"] !== undefined) fail();
      assertA2AStep(payload["step"]);
      if (envelope["actionIndex"] !== (payload["step"] as Record<string, Json>)["actionIndex"]) {
        fail();
      }
      break;
    case "rejected":
      if (
        !errorCodes.has(payload["code"] as A2AProgramErrorCode) ||
        encoder.encode(String(payload["message"])).byteLength > A2A_MAX_ERROR_TEXT_BYTES
      )
        fail();
      break;
    default:
      fail();
  }
}

function assertA2ACommand(command: Record<string, Json>, envelope: Record<string, Json>): void {
  switch (command["type"]) {
    case "start":
      if (envelope["actionIndex"] !== undefined) fail();
      break;
    case "resume":
      assertA2AOutcome(command["outcome"]);
      assertA2AReceipt(command["receipt"]);
      requireMatchingAction(command, envelope);
      break;
    case "authorize":
      if (command["descriptor"] !== undefined) assertA2AOperationDescriptor(command["descriptor"]);
      requireMatchingAction(command, envelope);
      break;
    case "ack_emission":
      requireMatchingAction(command, envelope);
      break;
    case "cancel":
      if (envelope["actionIndex"] !== undefined) fail();
      break;
    default:
      fail();
  }
}

function assertA2AStep(value: Json | undefined): void {
  const step = value as Record<string, Json>;
  switch (step["type"]) {
    case "operation":
      assertA2AOperationDescriptor(step["descriptor"]);
      if (step["authorizedOutcome"] !== undefined) assertA2AOutcome(step["authorizedOutcome"]);
      break;
    case "emission":
    case "completed":
      break;
    case "failed":
      assertA2AApplicationError(step["error"]);
      break;
    default:
      fail();
  }
}

function assertA2AOperationDescriptor(value: Json | undefined): void {
  const descriptor = value as Record<string, Json>;
  switch (descriptor["kind"]) {
    case "record":
      if (new TextEncoder().encode(String(descriptor["key"])).byteLength > 128) fail();
      break;
    case "effect":
    case "elicit":
      break;
    case "wait":
      if (
        descriptor["notBefore"] !== undefined &&
        !Number.isFinite(Date.parse(String(descriptor["notBefore"])))
      )
        fail();
      break;
    case "invoke":
    case "all":
    case "race":
      break;
    case "spawn":
      throw protocol("Remote spawn is not supported by caller-authoritative v1");
    case "join":
      throw protocol("Remote join handles are not supported by caller-authoritative v1");
    default:
      fail();
  }
}

function assertA2AOutcome(_value: Json | undefined): void {}
function assertA2AApplicationError(_value: Json | undefined): void {}
function assertA2AReceipt(_value: Json | undefined): void {}

function assertA2AReplayEntry(
  payload: Record<string, Json>,
  expected: "operation" | "emission",
): void {
  if (payload["type"] !== expected) fail();
  if (expected === "operation") {
    assertA2AOutcome(payload["outcome"]);
    assertA2AReceipt(payload["receipt"]);
  }
}

function parseCanonicalFrame(frame: string | Uint8Array): Json {
  const bytes = typeof frame === "string" ? encoder.encode(frame) : frame;
  if (bytes.byteLength > A2A_MAX_FRAME_BYTES) {
    throw a2aError("payload_too_large", "Frame exceeds 2 MiB");
  }
  let text: string;
  let value: Json;
  try {
    text =
      typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame);
    const decoded: unknown = JSON.parse(text);
    assertBoundedA2AJson(decoded);
    value = assertJson(decoded);
  } catch (error) {
    throw a2aError("program_protocol_error", "Malformed canonical JSON", error);
  }
  if (canonicalJson(value) !== text) {
    throw protocol("Frame is not canonical JSON");
  }
  return value;
}

function requireNoScope(envelope: Record<string, Json>): void {
  if (
    envelope["attachmentId"] !== undefined ||
    envelope["actionIndex"] !== undefined ||
    envelope["commandId"] !== undefined
  ) {
    fail();
  }
}
function requireAttachment(envelope: Record<string, Json>): void {
  if (!identifier(envelope["attachmentId"])) {
    fail();
  }
}
function requireAttachmentAndCommand(envelope: Record<string, Json>): void {
  requireAttachment(envelope);
  if (!identifier(envelope["commandId"])) {
    fail();
  }
}
function requireMatchingAction(
  command: Record<string, Json>,
  envelope: Record<string, Json>,
): void {
  if (
    typeof command["actionIndex"] !== "number" ||
    !Number.isSafeInteger(command["actionIndex"]) ||
    command["actionIndex"] < 0 ||
    command["actionIndex"] !== envelope["actionIndex"]
  ) {
    fail();
  }
}
function requireDigest(value: unknown): asserts value is string {
  if (!digest(value)) {
    fail();
  }
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
function fail(): never {
  throw protocol("Invalid A2A program protocol payload");
}
function protocol(message: string): CrankError {
  return a2aError("program_protocol_error", message);
}
export function a2aError(
  code: A2AProgramErrorCode,
  message: string = code,
  cause?: unknown,
): CrankError {
  return new CrankError(code, message, undefined, { cause });
}
