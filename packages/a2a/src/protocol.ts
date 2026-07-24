import {
  CrankError,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  type Json,
  type PinnedProgram,
  type ProgramCommand,
  type ProgramStep,
  type ReplayEntry,
} from "@sweatpants/session-contract";
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
  const value = parseCanonicalFrame(frame);
  if (
    !record(value) ||
    !exactKeys(value, [
      "type",
      "protocolVersion",
      "extensionUri",
      "executorId",
      "maxFrameBytes",
      "capabilities",
    ]) ||
    value["type"] !== "hello"
  ) {
    throw a2aError("extension_echo_mismatch", "Expected a closed executor hello frame");
  }
  if (
    value["protocolVersion"] !== A2A_PROTOCOL_VERSION ||
    value["extensionUri"] !== CALLER_AUTHORITATIVE_EXTENSION_URI
  ) {
    throw a2aError("extension_echo_mismatch", "Executor extension identity does not match");
  }
  if (!identifier(value["executorId"]) || value["maxFrameBytes"] !== A2A_MAX_FRAME_BYTES) fail();
  const capabilities = value["capabilities"];
  if (
    !record(capabilities) ||
    !exactKeys(capabilities, ["streamedRestore"]) ||
    typeof capabilities["streamedRestore"] !== "boolean"
  )
    fail();
  return canonicalSnapshot(value).value as unknown as ExecutorHelloV1;
}

export function parseClientProgramMessage(frame: string | Uint8Array): ClientProgramMessageV1 {
  return parseEnvelope(frame, clientTypes, validateClientPayload) as ClientProgramMessageV1;
}

export function parseServerProgramMessage(frame: string | Uint8Array): ServerProgramMessageV1 {
  return parseEnvelope(frame, serverTypes, validateServerPayload) as ServerProgramMessageV1;
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
  validatePayload: (type: string, envelope: Record<string, Json>) => void,
): ClientProgramMessageV1 | ServerProgramMessageV1 {
  const value = parseCanonicalFrame(frame);
  if (!record(value)) throw protocol("Envelope must be an object");
  if (
    !onlyKeys(
      value,
      [
        "protocolVersion",
        "extensionUri",
        "executionId",
        "program",
        "executionEpoch",
        "type",
        "payload",
      ],
      ["attachmentId", "actionIndex", "commandId"],
    )
  )
    throw protocol("Envelope fields are not closed");
  if (value["protocolVersion"] !== 1) {
    throw a2aError("protocol_version_unsupported", "Unsupported A2A program protocol version");
  }
  if (value["extensionUri"] !== CALLER_AUTHORITATIVE_EXTENSION_URI) {
    throw a2aError("extension_echo_mismatch", "A2A extension identity mismatch");
  }
  if (!identifier(value["executionId"]) || !positiveInteger(value["executionEpoch"])) fail();
  validateProgram(value["program"]);
  const type = value["type"];
  if (typeof type !== "string" || !allowedTypes.has(type)) throw protocol("Unknown message type");
  if (value["attachmentId"] !== undefined && !identifier(value["attachmentId"])) fail();
  if (value["actionIndex"] !== undefined && !nonnegativeInteger(value["actionIndex"])) fail();
  if (value["commandId"] !== undefined && !identifier(value["commandId"])) fail();
  if (!record(value["payload"])) throw protocol("Payload must be an object");
  validatePayload(type, value);
  return canonicalSnapshot(value).value as unknown as
    | ClientProgramMessageV1
    | ServerProgramMessageV1;
}

function validateClientPayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "attach_begin":
      if (
        !exactKeys(payload, ["input", "inputDigest", "affinity"]) ||
        !digest(payload["inputDigest"]) ||
        !affinity(payload["affinity"])
      )
        fail();
      requireNoScope(envelope);
      break;
    case "restore_begin":
      if (
        !exactKeys(payload, [
          "input",
          "inputDigest",
          "replayedThroughActionIndex",
          "replayChainSeed",
          "affinity",
        ]) ||
        !digest(payload["inputDigest"]) ||
        !affinity(payload["affinity"]) ||
        !replayPosition(payload["replayedThroughActionIndex"]) ||
        !digest(payload["replayChainSeed"])
      )
        fail();
      requireNoScope(envelope);
      break;
    case "command": {
      if (!exactKeys(payload, ["command"]) || !record(payload["command"])) fail();
      requireAttachmentAndCommand(envelope);
      validateCommand(payload["command"] as Record<string, Json>, envelope);
      break;
    }
    case "shutdown":
      if (
        !exactKeys(payload, ["reason"]) ||
        !["parked", "completed", "failed", "cancelled", "transport_lost", "scope_exit"].includes(
          String(payload["reason"]),
        )
      )
        fail();
      requireAttachmentAndCommand(envelope);
      break;
    case "replay_operation":
    case "replay_emission":
      requireAttachment(envelope);
      if (envelope["commandId"] !== undefined) fail();
      validateReplayEntry(payload, type === "replay_operation" ? "operation" : "emission");
      if (envelope["actionIndex"] !== payload["actionIndex"]) fail();
      break;
    case "replay_end":
      requireAttachment(envelope);
      if (
        envelope["actionIndex"] !== undefined ||
        envelope["commandId"] !== undefined ||
        !exactKeys(payload, ["entryCount", "replayChainDigest"]) ||
        !nonnegativeInteger(payload["entryCount"]) ||
        !digest(payload["replayChainDigest"])
      )
        fail();
      break;
    default:
      fail();
  }
}

function validateServerPayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "attachment_ready":
    case "restore_ready":
      if (
        !exactKeys(payload, ["attachmentId", "computeGeneration"]) ||
        !identifier(payload["attachmentId"]) ||
        !identifier(payload["computeGeneration"]) ||
        envelope["attachmentId"] !== payload["attachmentId"] ||
        envelope["actionIndex"] !== undefined ||
        envelope["commandId"] !== undefined
      )
        fail();
      break;
    case "step":
      requireAttachmentAndCommand(envelope);
      if (!exactKeys(payload, ["step"])) fail();
      validateStep(payload["step"]);
      if (record(payload["step"]) && envelope["actionIndex"] !== payload["step"]["actionIndex"])
        fail();
      break;
    case "shutdown_complete":
      requireAttachmentAndCommand(envelope);
      if (!exactKeys(payload, []) || envelope["actionIndex"] !== undefined) fail();
      break;
    case "frontier":
      requireAttachment(envelope);
      if (
        envelope["commandId"] !== undefined ||
        !exactKeys(payload, [
          "step",
          "replayedThroughActionIndex",
          "replayChainDigest",
          "frontierDigest",
        ]) ||
        !replayPosition(payload["replayedThroughActionIndex"]) ||
        !digest(payload["replayChainDigest"]) ||
        !digest(payload["frontierDigest"])
      )
        fail();
      validateStep(payload["step"]);
      if (record(payload["step"]) && envelope["actionIndex"] !== payload["step"]["actionIndex"])
        fail();
      break;
    case "rejected":
      if (
        !exactKeys(payload, ["code", "message"]) ||
        !errorCodes.has(payload["code"] as A2AProgramErrorCode) ||
        typeof payload["message"] !== "string" ||
        encoder.encode(payload["message"]).byteLength > A2A_MAX_ERROR_TEXT_BYTES
      )
        fail();
      break;
    default:
      fail();
  }
}

function validateCommand(command: Record<string, Json>, envelope: Record<string, Json>): void {
  switch (command["type"]) {
    case "start":
      if (!exactKeys(command, ["type", "input"]) || envelope["actionIndex"] !== undefined) fail();
      break;
    case "resume":
      if (
        !exactKeys(command, ["type", "actionIndex", "outcome", "receipt", "replayed"]) ||
        typeof command["replayed"] !== "boolean"
      )
        fail();
      validateOutcome(command["outcome"]);
      validateReceipt(command["receipt"]);
      requireMatchingAction(command, envelope);
      break;
    case "authorize":
      if (
        !onlyKeys(
          command,
          ["type", "actionIndex", "pullId", "attemptId"],
          ["descriptor", "effectContractDigest"],
        )
      )
        fail();
      if (!identifier(command["pullId"]) || !identifier(command["attemptId"])) fail();
      if (command["descriptor"] !== undefined) validateOperationDescriptor(command["descriptor"]);
      if (command["effectContractDigest"] !== undefined && !digest(command["effectContractDigest"]))
        fail();
      requireMatchingAction(command, envelope);
      break;
    case "ack_emission":
      if (!exactKeys(command, ["type", "actionIndex", "offset"]) || !identifier(command["offset"]))
        fail();
      requireMatchingAction(command, envelope);
      break;
    case "cancel":
      if (!onlyKeys(command, ["type"], ["reason"]) || envelope["actionIndex"] !== undefined) fail();
      if (command["reason"] !== undefined && typeof command["reason"] !== "string") fail();
      break;
    default:
      fail();
  }
}

function validateStep(value: Json | undefined): asserts value is Json {
  if (!record(value) || !nonnegativeInteger(value["actionIndex"])) fail();
  switch (value["type"]) {
    case "operation":
      if (!onlyKeys(value, ["type", "actionIndex", "descriptor"], ["authorizedOutcome"])) fail();
      validateOperationDescriptor(value["descriptor"]);
      if (value["authorizedOutcome"] !== undefined) validateOutcome(value["authorizedOutcome"]);
      break;
    case "emission":
      if (!exactKeys(value, ["type", "actionIndex", "descriptor"])) fail();
      if (
        !record(value["descriptor"]) ||
        !exactKeys(value["descriptor"], ["eventType", "payload"]) ||
        !identifier(value["descriptor"]["eventType"])
      )
        fail();
      break;
    case "completed":
      if (!exactKeys(value, ["type", "actionIndex", "value"])) fail();
      break;
    case "failed":
      if (!exactKeys(value, ["type", "actionIndex", "error"])) fail();
      validateApplicationError(value["error"]);
      break;
    default:
      fail();
  }
}

function validateOperationDescriptor(value: Json | undefined): void {
  if (!record(value)) fail();
  switch (value["kind"]) {
    case "record": {
      if (!onlyKeys(value, ["kind", "retrySafety"], ["label"])) fail();
      if (
        value["label"] !== undefined &&
        (typeof value["label"] !== "string" ||
          value["label"].length === 0 ||
          new TextEncoder().encode(value["label"]).byteLength > 128)
      )
        fail();
      const safety = value["retrySafety"];
      if (!record(safety)) fail();
      if (safety["mode"] === "repeatable") {
        if (!exactKeys(safety, ["mode"])) fail();
      } else if (safety["mode"] === "idempotent") {
        if (
          !exactKeys(safety, ["mode", "mechanism"]) ||
          (safety["mechanism"] !== "pull_id_key" && safety["mechanism"] !== "inherent")
        )
          fail();
      } else if (safety["mode"] === "unsafe") {
        if (
          !exactKeys(safety, ["mode", "onIndeterminate"]) ||
          (safety["onIndeterminate"] !== "await_decision" && safety["onIndeterminate"] !== "fail")
        )
          fail();
      } else fail();
      break;
    }
    case "effect":
      if (!exactKeys(value, ["kind", "name", "version", "input", "resolver"])) fail();
      if (!identifier(value["name"]) || !identifier(value["version"]) || !record(value["resolver"]))
        fail();
      if (!onlyKeys(value["resolver"], ["audience"], ["route"])) fail();
      if (!identifier(value["resolver"]["audience"])) fail();
      if (
        value["resolver"]["route"] !== undefined &&
        typeof value["resolver"]["route"] !== "string"
      )
        fail();
      break;
    case "elicit":
      if (!onlyKeys(value, ["kind", "key", "message", "response"], ["context"])) fail();
      if (
        !identifier(value["key"]) ||
        typeof value["message"] !== "string" ||
        !record(value["response"])
      )
        fail();
      break;
    case "wait": {
      if (!onlyKeys(value, ["kind", "key"], ["notBefore", "durationMs"])) fail();
      if (!identifier(value["key"])) fail();
      const absolute = typeof value["notBefore"] === "string";
      const relative = nonnegativeInteger(value["durationMs"]);
      if (absolute === relative) fail();
      break;
    }
    case "invoke":
      if (!exactKeys(value, ["kind", "child"])) fail();
      validateChild(value["child"]);
      break;
    case "all":
    case "race":
      if (!exactKeys(value, ["kind", "children"]) || !Array.isArray(value["children"])) fail();
      for (const child of value["children"] as Json[]) validateChild(child);
      break;
    case "spawn":
      // The wire remains provider-neutral, but caller-authoritative v1 routes only joined invoke.
      throw protocol("Remote spawn is not supported by caller-authoritative v1");
    case "join":
      throw protocol("Remote join handles are not supported by caller-authoritative v1");
    default:
      fail();
  }
}

function validateChild(value: Json | undefined): void {
  if (!record(value) || !exactKeys(value, ["id", "version", "digest", "input"])) fail();
  if (!identifier(value["id"]) || !identifier(value["version"]) || !digest(value["digest"])) fail();
}

function validateOutcome(value: Json | undefined): void {
  if (!record(value)) fail();
  if (value["status"] === "ok") {
    if (!exactKeys(value, ["status", "value"])) fail();
  } else if (value["status"] === "error") {
    if (!exactKeys(value, ["status", "error"])) fail();
    validateApplicationError(value["error"]);
  } else if (value["status"] === "cancelled") {
    if (!onlyKeys(value, ["status"], ["partial"])) fail();
  } else fail();
}

function validateApplicationError(value: Json | undefined): void {
  if (!record(value) || !onlyKeys(value, ["code", "message"], ["details"])) fail();
  if (!identifier(value["code"]) || typeof value["message"] !== "string") fail();
}

function validateReceipt(value: Json | undefined): void {
  if (
    !record(value) ||
    !exactKeys(value, [
      "sessionId",
      "taskId",
      "pullId",
      "resolutionOffset",
      "outcomeDigest",
      "status",
    ])
  )
    fail();
  for (const key of ["sessionId", "taskId", "pullId", "resolutionOffset"])
    if (!identifier(value[key])) fail();
  if (
    !digest(value["outcomeDigest"]) ||
    !["accepted", "duplicate"].includes(String(value["status"]))
  )
    fail();
}

function validateReplayEntry(
  payload: Record<string, Json>,
  expected: "operation" | "emission",
): void {
  const common = [
    "type",
    "actionIndex",
    "descriptorKind",
    "descriptorDigest",
    "previousEntryDigest",
    "entryDigest",
  ];
  const variant = expected === "operation" ? ["outcome", "receipt"] : ["offset"];
  if (
    !exactKeys(payload, [...common, ...variant]) ||
    payload["type"] !== expected ||
    !nonnegativeInteger(payload["actionIndex"]) ||
    !identifier(payload["descriptorKind"]) ||
    !digest(payload["descriptorDigest"]) ||
    !digest(payload["previousEntryDigest"]) ||
    !digest(payload["entryDigest"])
  )
    fail();
  if (expected === "operation") {
    validateOutcome(payload["outcome"]);
    validateReceipt(payload["receipt"]);
  } else if (!identifier(payload["offset"])) fail();
}

function parseCanonicalFrame(frame: string | Uint8Array): Json {
  const bytes = typeof frame === "string" ? encoder.encode(frame) : frame;
  if (bytes.byteLength > A2A_MAX_FRAME_BYTES)
    throw a2aError("payload_too_large", "Frame exceeds 2 MiB");
  let text: string;
  let value: Json;
  try {
    text =
      typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame);
    value = assertJson(JSON.parse(text));
  } catch (error) {
    throw a2aError("program_protocol_error", "Malformed canonical JSON", error);
  }
  if (canonicalJson(value) !== text) throw protocol("Frame is not canonical JSON");
  return value;
}

function validateProgram(value: Json | undefined): asserts value is Json {
  if (!record(value) || !exactKeys(value, ["id", "version", "digest"])) fail();
  if (!identifier(value["id"]) || !identifier(value["version"]) || !digest(value["digest"])) fail();
}
function requireNoScope(envelope: Record<string, Json>): void {
  if (
    envelope["attachmentId"] !== undefined ||
    envelope["actionIndex"] !== undefined ||
    envelope["commandId"] !== undefined
  )
    fail();
}
function requireAttachment(envelope: Record<string, Json>): void {
  if (!identifier(envelope["attachmentId"])) fail();
}
function requireAttachmentAndCommand(envelope: Record<string, Json>): void {
  requireAttachment(envelope);
  if (!identifier(envelope["commandId"])) fail();
}
function requireMatchingAction(
  command: Record<string, Json>,
  envelope: Record<string, Json>,
): void {
  if (
    !nonnegativeInteger(command["actionIndex"]) ||
    command["actionIndex"] !== envelope["actionIndex"]
  )
    fail();
}
function requireDigest(value: unknown): asserts value is string {
  if (!digest(value)) fail();
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
function affinity(value: unknown): boolean {
  return Boolean(
    record(value) &&
    exactKeys(value, ["kind", "key"]) &&
    ["invocation", "conversation", "workspace"].includes(String(value["kind"])) &&
    identifier(value["key"]),
  );
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function replayPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
}
function exactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function onlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
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
