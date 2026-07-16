import {
  CrankError,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  type AttachProgramRequest,
  type Json,
  type ProgramAttachment,
  type ProgramCommand,
  type ProgramShutdownReason,
  type ProgramStep,
  type ReplayEmissionEntry,
  type ReplayEntry,
  type ReplayOperationEntry,
} from "@sweatpants/session-contract";

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

const hostTypes = new Set([
  "restore_begin",
  "replay_operation",
  "replay_emission",
  "replay_end",
  "command",
  "shutdown",
]);
const runtimeTypes = new Set([
  "restore_ready",
  "frontier",
  "step",
  "shutdown_complete",
  "rejected",
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
  return parseMessage(frame, hostTypes, validateHostPayload) as HostProgramMessage;
}

export function parseRuntimeProgramMessage(frame: string | Uint8Array): RuntimeProgramMessage {
  return parseMessage(frame, runtimeTypes, validateRuntimePayload) as RuntimeProgramMessage;
}

function parseMessage(
  frame: string | Uint8Array,
  allowed: ReadonlySet<string>,
  validatePayload: (type: string, envelope: Record<string, Json>) => void,
): HostProgramMessage | RuntimeProgramMessage {
  const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  if (bytes.byteLength > AGENTCORE_MAX_FRAME_BYTES)
    throw protocol("payload_too_large", "Frame exceeds 2 MiB");
  let value: Json;
  try {
    value = assertJson(
      JSON.parse(
        typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame),
      ),
    );
  } catch (error) {
    throw protocol("program_protocol_error", "Malformed canonical JSON", error);
  }
  if (!record(value)) throw protocol("program_protocol_error", "Envelope must be an object");
  const required = ["protocolVersion", "type", "releaseId", "taskId", "activationEpoch", "payload"];
  const optional = ["attachmentId", "actionIndex"];
  if (!onlyKeys(value, required, optional))
    throw protocol("program_protocol_error", "Envelope fields are not closed");
  if (value["protocolVersion"] !== AGENTCORE_DURABLE_PROTOCOL_VERSION)
    throw protocol("protocol_version_unsupported", "Unsupported protocol version");
  const type = value["type"];
  if (typeof type !== "string" || !allowed.has(type))
    throw protocol("program_protocol_error", "Unknown protocol message type");
  if (
    !nonempty(value["releaseId"]) ||
    !nonempty(value["taskId"]) ||
    !integer(value["activationEpoch"])
  )
    throw protocol("program_protocol_error", "Invalid envelope identity");
  if (value["attachmentId"] !== undefined && !nonempty(value["attachmentId"]))
    throw protocol("program_protocol_error", "Invalid attachment identity");
  if (value["actionIndex"] !== undefined && !integer(value["actionIndex"]))
    throw protocol("program_protocol_error", "Invalid action index");
  if (!record(value["payload"]))
    throw protocol("program_protocol_error", "Payload must be an object");
  validatePayload(type, value);
  return canonicalSnapshot(value).value as unknown as HostProgramMessage | RuntimeProgramMessage;
}

function validateHostPayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "restore_begin": {
      if (
        !exactKeys(payload, [
          "attach",
          "programInputDigest",
          "replayedThroughActionIndex",
          "replayChainSeed",
        ]) ||
        !record(payload["attach"]) ||
        !nonempty(payload["programInputDigest"]) ||
        !replayPosition(payload["replayedThroughActionIndex"]) ||
        !digest(payload["replayChainSeed"])
      )
        fail();
      const attach = payload["attach"] as Record<string, Json>;
      if (
        !exactKeys(attach, [
          "sessionId",
          "taskId",
          "program",
          "input",
          "route",
          "executionEpoch",
        ]) ||
        attach["taskId"] !== envelope["taskId"] ||
        attach["executionEpoch"] !== envelope["activationEpoch"] ||
        !record(attach["program"])
      )
        fail();
      break;
    }
    case "replay_operation":
    case "replay_emission":
      validateReplayEntry(payload, type === "replay_operation" ? "operation" : "emission");
      if (envelope["actionIndex"] !== payload["actionIndex"] || !nonempty(envelope["attachmentId"]))
        fail();
      break;
    case "replay_end":
      if (
        !exactKeys(payload, ["entryCount", "replayChainDigest"]) ||
        !integer(payload["entryCount"]) ||
        !digest(payload["replayChainDigest"]) ||
        !nonempty(envelope["attachmentId"])
      )
        fail();
      break;
    case "command": {
      if (
        !exactKeys(payload, ["command"]) ||
        !record(payload["command"]) ||
        !nonempty(envelope["attachmentId"])
      )
        fail();
      const command = payload["command"] as Record<string, Json>;
      if (
        !nonempty(command["type"]) ||
        !["start", "resume", "authorize", "ack_emission", "cancel"].includes(
          String(command["type"]),
        )
      )
        fail();
      if (
        ["resume", "authorize", "ack_emission"].includes(String(command["type"])) &&
        envelope["actionIndex"] !== command["actionIndex"]
      )
        fail();
      break;
    }
    case "shutdown":
      if (
        !exactKeys(payload, ["reason"]) ||
        !["parked", "completed", "failed", "cancelled", "transport_lost", "scope_exit"].includes(
          String(payload["reason"]),
        ) ||
        !nonempty(envelope["attachmentId"])
      )
        fail();
  }
}

function validateRuntimePayload(type: string, envelope: Record<string, Json>): void {
  const payload = envelope["payload"] as Record<string, Json>;
  switch (type) {
    case "restore_ready":
      if (
        !exactKeys(payload, ["attachment", "computeGeneration"]) ||
        !record(payload["attachment"]) ||
        !nonempty(payload["computeGeneration"])
      )
        fail();
      break;
    case "frontier":
      if (
        !exactKeys(payload, [
          "step",
          "replayedThroughActionIndex",
          "replayChainDigest",
          "frontierDigest",
        ]) ||
        !validStep(payload["step"]) ||
        !replayPosition(payload["replayedThroughActionIndex"]) ||
        !digest(payload["replayChainDigest"]) ||
        !digest(payload["frontierDigest"]) ||
        !nonempty(envelope["attachmentId"])
      )
        fail();
      break;
    case "step":
      if (
        !exactKeys(payload, ["step"]) ||
        !validStep(payload["step"]) ||
        !nonempty(envelope["attachmentId"])
      )
        fail();
      if (record(payload["step"]) && envelope["actionIndex"] !== payload["step"]["actionIndex"])
        fail();
      break;
    case "shutdown_complete":
      if (!exactKeys(payload, []) || !nonempty(envelope["attachmentId"])) fail();
      break;
    case "rejected":
      if (
        !exactKeys(payload, ["code", "message"]) ||
        !errorCodes.has(payload["code"] as AgentCoreDurableProgramErrorCode) ||
        typeof payload["message"] !== "string" ||
        new TextEncoder().encode(payload["message"]).byteLength > AGENTCORE_MAX_ERROR_TEXT_BYTES
      )
        fail();
      break;
  }
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
    !integer(payload["actionIndex"]) ||
    !nonempty(payload["descriptorKind"]) ||
    !digest(payload["descriptorDigest"]) ||
    !digest(payload["previousEntryDigest"]) ||
    !digest(payload["entryDigest"])
  )
    fail();
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
  if (!digest(seed) || !digest(previousEntryDigest))
    throw protocol("program_protocol_error", "Invalid replay chain digest");
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
  if (claimedPrevious !== previousEntryDigest) return false;
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

function validStep(value: Json | undefined): boolean {
  return (
    record(value) &&
    ["operation", "emission", "completed", "failed"].includes(String(value["type"])) &&
    integer(value["actionIndex"])
  );
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function replayPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
  throw protocol("program_protocol_error", "Invalid protocol payload");
}
function protocol(
  code: AgentCoreDurableProgramErrorCode,
  message: string,
  cause?: unknown,
): CrankError {
  return new CrankError(code, message, undefined, { cause });
}
