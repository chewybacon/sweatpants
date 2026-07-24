import type {
  DurableProgramManifest,
  Json,
  PinnedProgram,
  ProgramCommand,
  ProgramShutdownReason,
  ProgramStep,
  ReplayEmissionEntry,
  ReplayOperationEntry,
  SandboxAffinity,
} from "@sweatpants/session-contract";

export const CALLER_AUTHORITATIVE_EXTENSION_URI =
  "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/caller-authoritative-program/v1/spec.md";
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions";
export const A2A_PROTOCOL_VERSION = 1 as const;
export const A2A_MAX_FRAME_BYTES = 2097152 as const;
export const A2A_MAX_INLINE_INPUT_BYTES = 1024 * 1024;
export const A2A_MAX_ERROR_TEXT_BYTES = 4 * 1024;

export type A2AProgramErrorCode =
  | "agent_card_invalid"
  | "unsafe_url"
  | "authentication_failed"
  | "authorization_denied"
  | "extension_not_advertised"
  | "extension_not_activated"
  | "extension_echo_mismatch"
  | "protocol_version_unsupported"
  | "manifest_not_found"
  | "manifest_mismatch"
  | "program_version_unavailable"
  | "schema_version_unavailable"
  | "effect_handler_missing"
  | "effect_contract_mismatch"
  | "identity_mismatch"
  | "stale_activation"
  | "idempotency_conflict"
  | "payload_too_large"
  | "replay_diverged"
  | "history_not_exhausted"
  | "program_protocol_error"
  | "deadline_exceeded"
  | "transport_lost";

export interface CallerAuthoritativeProgramExtensionParamsV1 {
  protocolVersion: 1;
  manifestEndpoint: string;
  driverEndpoint: string;
  programs: Array<{ skillId: string; program: PinnedProgram }>;
}

export interface AgentExtensionV1 {
  uri: string;
  description?: string;
  required?: boolean;
  params: CallerAuthoritativeProgramExtensionParamsV1;
}

export interface DiscoveredCallerAuthoritativeProgramV1 {
  card: Json;
  cardUrl?: string;
  cardDigest: string;
  extension: AgentExtensionV1;
  programForSkill(skillId: string): PinnedProgram;
}

export interface RemoteProgramManifestDocumentV1 {
  protocolVersion: 1;
  extensionUri: typeof CALLER_AUTHORITATIVE_EXTENSION_URI;
  program: PinnedProgram;
  manifest: DurableProgramManifest;
  manifestDigest: string;
  capabilities: { ordinaryReplay: true; streamedRestore: boolean };
}

export interface ExecutorHelloV1 {
  type: "hello";
  protocolVersion: 1;
  extensionUri: typeof CALLER_AUTHORITATIVE_EXTENSION_URI;
  executorId: string;
  maxFrameBytes: 2097152;
  capabilities: { streamedRestore: boolean };
}

export interface ProgramEnvelopeV1<TType extends string, TPayload> {
  protocolVersion: 1;
  extensionUri: typeof CALLER_AUTHORITATIVE_EXTENSION_URI;
  executionId: string;
  program: PinnedProgram;
  executionEpoch: number;
  type: TType;
  attachmentId?: string;
  actionIndex?: number;
  commandId?: string;
  payload: TPayload;
}

/** Transport-safe ProgramCommand projection. Authorization capabilities never cross this boundary. */
export type WireProgramCommandV1 =
  | Extract<ProgramCommand, { type: "start" | "resume" | "ack_emission" | "cancel" }>
  | Omit<Extract<ProgramCommand, { type: "authorize" }>, "resolutionCapability">;

export type AttachBeginV1 = ProgramEnvelopeV1<
  "attach_begin",
  { input: Json; inputDigest: string; affinity: SandboxAffinity }
>;
export type ProgramCommandFrameV1 = ProgramEnvelopeV1<"command", { command: WireProgramCommandV1 }>;
export type ShutdownFrameV1 = ProgramEnvelopeV1<"shutdown", { reason: ProgramShutdownReason }>;
export type RestoreBeginV1 = ProgramEnvelopeV1<
  "restore_begin",
  {
    input: Json;
    inputDigest: string;
    replayedThroughActionIndex: number;
    replayChainSeed: string;
    affinity: SandboxAffinity;
  }
>;
export type ReplayOperationFrameV1 = ProgramEnvelopeV1<"replay_operation", ReplayOperationEntry>;
export type ReplayEmissionFrameV1 = ProgramEnvelopeV1<"replay_emission", ReplayEmissionEntry>;
export type ReplayEndV1 = ProgramEnvelopeV1<
  "replay_end",
  { entryCount: number; replayChainDigest: string }
>;

export type ClientProgramMessageV1 =
  | AttachBeginV1
  | ProgramCommandFrameV1
  | ShutdownFrameV1
  | RestoreBeginV1
  | ReplayOperationFrameV1
  | ReplayEmissionFrameV1
  | ReplayEndV1;

export type AttachmentReadyV1 = ProgramEnvelopeV1<
  "attachment_ready",
  { attachmentId: string; computeGeneration: string }
>;
export type StepFrameV1 = ProgramEnvelopeV1<"step", { step: ProgramStep }>;
export type ShutdownCompleteV1 = ProgramEnvelopeV1<"shutdown_complete", Record<string, never>>;
export type RestoreReadyV1 = ProgramEnvelopeV1<
  "restore_ready",
  { attachmentId: string; computeGeneration: string }
>;
export type FrontierV1 = ProgramEnvelopeV1<
  "frontier",
  {
    step: ProgramStep;
    replayedThroughActionIndex: number;
    replayChainDigest: string;
    frontierDigest: string;
  }
>;
export type RejectedV1 = ProgramEnvelopeV1<
  "rejected",
  { code: A2AProgramErrorCode; message: string }
>;

export type ServerProgramMessageV1 =
  | AttachmentReadyV1
  | StepFrameV1
  | ShutdownCompleteV1
  | RestoreReadyV1
  | FrontierV1
  | RejectedV1;

export interface AcceptedCommandRecordV1 {
  commandId: string;
  commandDigest: string;
  responseType: "step" | "shutdown_complete";
  responseDigest: string;
  canonicalResponse: Json;
}

export interface A2AProgramRouteV1 {
  driverKind: "a2a";
  protocolVersion: 1;
  extensionUri: typeof CALLER_AUTHORITATIVE_EXTENSION_URI;
  executionId: string;
  driverEndpoint: string;
  cardOrigin: string;
}

export interface A2ARequestAuthorization {
  headers: Readonly<Record<string, string>>;
  principalId?: string;
  tenantId?: string;
}
