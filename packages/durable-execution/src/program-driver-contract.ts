/**
 * Program driver protocol declarations.
 *
 * The wire vocabulary between a host and whatever executes a pinned program:
 * attachment, ordered commands, steps, and streamed replay. Depends only on the
 * contract layer.
 */

import type { Operation } from "effection";
import type { Json, SerializedApplicationError } from "@sweatpants/foundation";
import type { ProgramPlacementContextValue } from "@sweatpants/durable-effects";
import type {
  DurableOperationDescriptor,
  DurableProgramManifest,
  EffectDescriptor,
  EmissionDescriptor,
  OperationOutcome,
  PinnedProgram,
  RecordedOperationDescriptor,
  SandboxAffinity,
} from "./program-contract.ts";

/** Trusted context used by the authority to derive a nonce-hiding replay chain. */
export interface ProgramRestoreContext {
  readonly replayDomain: string;
  readonly frontierDomain: string;
  readonly releaseId: string;
  readonly sandboxSessionId: string;
}

/** Stable receipt proving acceptance or idempotent replay of one resolution. */
export interface ResolutionReceipt {
  sessionId: string;
  taskId: string;
  pullId: string;
  resolutionOffset: string;
  outcomeDigest: string;
  status: "accepted" | "duplicate";
}

/** Driver-owned canonical routing data persisted with attachment requests. */
export type ProgramRoute = Json;

/** Complete request for attaching to a pinned task execution epoch. */
export interface AttachProgramRequest {
  sessionId: string;
  taskId: string;
  program: PinnedProgram;
  input: Json;
  route: ProgramRoute;
  executionEpoch: number;
  /** Deployment-approved opaque affinity projected by a trust-boundary driver. */
  affinity?: SandboxAffinity;
}

/** Runtime-only attachment; its handle MUST NOT enter durable JSON. */
export interface ProgramAttachment {
  attachmentId: string;
  taskId: string;
  driverKind: "program" | "worker" | "agentcore" | "mcp" | (string & {});
  route: ProgramRoute;
  executionEpoch: number;
  /** Runtime-only and deliberately excluded from durable JSON. */
  handle: unknown;
}

/** Commands accepted by a program driver under ordered action indices. */
export type ProgramCommand =
  | { type: "start"; input: Json }
  | {
      type: "resume";
      actionIndex: number;
      outcome: OperationOutcome;
      receipt: ResolutionReceipt;
      replayed: boolean;
    }
  | {
      type: "authorize";
      actionIndex: number;
      pullId: string;
      attemptId: string;
      resolutionCapability: string;
      descriptor?: EffectDescriptor | RecordedOperationDescriptor;
      effectContractDigest?: string;
      /** Authority-established evidence forwarded into execution placement. */
      placement?: ProgramPlacementContextValue;
    }
  | { type: "ack_emission"; actionIndex: number; offset: string }
  | { type: "cancel"; reason?: string };

/** Exhaustive observable step returned by a program driver. */
export type ProgramStep =
  | {
      type: "operation";
      actionIndex: number;
      descriptor: DurableOperationDescriptor;
      /** Transient authorize response; never persisted as a replay frontier. */
      authorizedOutcome?: OperationOutcome;
    }
  | { type: "emission"; actionIndex: number; descriptor: EmissionDescriptor }
  | { type: "completed"; actionIndex: number; value: Json }
  | { type: "failed"; actionIndex: number; error: SerializedApplicationError };

/** Stable reason algebra for releasing a driver attachment. */
export type ProgramShutdownReason =
  | "parked"
  | "completed"
  | "failed"
  | "cancelled"
  | "transport_lost"
  | "scope_exit";

/** One bounded operation entry streamed during fresh-task restoration. */
export interface ReplayOperationEntry {
  readonly type: "operation";
  readonly actionIndex: number;
  readonly descriptorKind: string;
  readonly descriptorDigest: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly outcome: OperationOutcome;
  readonly receipt: ResolutionReceipt;
}

/** One bounded emission acknowledgement streamed during restoration. */
export interface ReplayEmissionEntry {
  readonly type: "emission";
  readonly actionIndex: number;
  readonly descriptorKind: string;
  readonly descriptorDigest: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly offset: string;
}

export type ReplayEntry = ReplayOperationEntry | ReplayEmissionEntry;

/** Async-agnostic replay source; implementations may stream without buffering history. */
export interface ProgramReplayStream {
  readonly [Symbol.iterator]?: () => Iterator<ReplayEntry>;
  readonly [Symbol.asyncIterator]?: () => AsyncIterator<ReplayEntry>;
}

export interface ProgramRestoreRequest {
  readonly attach: AttachProgramRequest;
  readonly replay: ProgramReplayStream;
  readonly replayedThroughActionIndex: number;
  readonly replayChainSeed: string;
  readonly replayChainDigest: string;
}

export interface RestoredProgramAttachment {
  readonly attachment: ProgramAttachment;
  readonly frontier: ProgramStep;
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
  readonly frontierDigest: string;
  readonly computeGeneration?: string;
}

/** Scoped adapter port for attaching, restoring, stepping, and shutting down one artifact. */
export interface ReplayCheckpointCapability {
  readonly kind: "replay";
  readonly version: 1;
}

export interface ContinuationCheckpointCapability {
  readonly kind: "continuation";
  readonly version: string;
  readonly format: string;
}

export interface ProgramDriverCapabilities {
  readonly replay: ReplayCheckpointCapability;
  readonly continuation?: ContinuationCheckpointCapability;
}

export const REPLAY_CHECKPOINT_CAPABILITIES: ProgramDriverCapabilities = Object.freeze({
  replay: Object.freeze({ kind: "replay", version: 1 }),
});

export interface ProgramDriver {
  /** Current drivers restore by replay; continuation serialization is explicit and optional. */
  readonly capabilities: ProgramDriverCapabilities;
  /** Acquires an attachment owned by the caller's Effection scope. */
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  /** Applies one ordered command and returns exactly one program step. */
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  /** Releases attachment resources on every terminal or scope-exit path. */
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
  /** Optional streamed fresh-task replay fast path. */
  restore?(request: ProgramRestoreRequest): Operation<RestoredProgramAttachment>;
  /** Supplies driver-owned serializable identity/digest domains for authority restoration. */
  restoreContext?(request: AttachProgramRequest): Operation<ProgramRestoreContext>;
  /** Resolves an exact pinned manifest when the driver owns artifact lookup. */
  manifest?(program: PinnedProgram): Operation<DurableProgramManifest>;
}

/** Runtime request controlling attachment and optional in-scope host dispatch. */
export interface ProgramRunRequest {
  attach: AttachProgramRequest;
  programCapability?: string;
  /** Host-private owner used to issue/consume restore tickets under a claimed lease. */
  activationOwnerId?: string;
}

/** One participant-addressable parked slot on the active leaf frontier. */
export interface ProgramParkedSlot {
  readonly taskId: string;
  readonly pullId: string;
  readonly reason: string;
}

/** Caller-visible terminal or parked result of one runtime activation. */
export type AdvancementResult =
  | { state: "completed"; value: Json }
  | { state: "failed"; error: SerializedApplicationError }
  | { state: "cancelled" }
  | {
      state: "parked";
      pullId: string;
      reason: string;
      /**
       * Bounded open-slot set when a fork group parks with several live
       * members (REQ-028): every slot is participant-addressable. Absent for
       * single-park results; `pullId` remains the primary slot either way.
       */
      slots?: readonly ProgramParkedSlot[];
    };
