import type { Json } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects/contract";

export interface ReplayEntry {
  readonly actionIndex: number;
  readonly descriptorKind: string;
  readonly descriptorDigest: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly outcome?: OperationOutcome;
  readonly offset?: string;
}

export interface ProgramReplayStream {
  readonly [Symbol.iterator]?: () => Iterator<ReplayEntry>;
  readonly [Symbol.asyncIterator]?: () => AsyncIterator<ReplayEntry>;
}

export interface ReplayCheckpointCapability {
  readonly kind: "replay";
  readonly version: 1;
}

/** Optional future extension; current drivers remain replay-only. */
export interface ContinuationCheckpointCapability {
  readonly kind: "continuation";
  readonly version: string;
  readonly format: string;
}

export interface ProgramDriverCapabilities {
  readonly replay: ReplayCheckpointCapability;
  readonly continuation?: ContinuationCheckpointCapability;
}

export interface ProgramRestoreRequest {
  readonly replay: ProgramReplayStream;
  readonly replayedThroughActionIndex: number;
  readonly replayChainSeed: string;
  readonly replayChainDigest: string;
  readonly attachment: Json;
}
