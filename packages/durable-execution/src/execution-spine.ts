import type { Json } from "@sweatpants/foundation";
import type {
  ProgramAttachment,
  ProgramRoute,
  ReplayEntry,
  RestoredProgramAttachment,
} from "./program-driver-contract.ts";
import type { PinnedProgram, SandboxAffinity } from "./program-contract.ts";

/** Identity is admitted once; task ids remain opaque below this boundary. */
export interface TurnAddress {
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskId: string;
}

export interface StrandHead {
  readonly actionIndex: number;
  readonly digest: string;
}

export interface ForkContext {
  readonly groupId?: string;
  readonly groupRevision: number;
  readonly parentTaskId?: string;
}

/** Closed placement taxonomy. Durability remains an independent field. */
export type PlacementRoute =
  | { readonly kind: "local"; readonly driverKind: string; readonly route: ProgramRoute }
  | { readonly kind: "worker"; readonly driverKind: string; readonly route: ProgramRoute }
  | { readonly kind: "remote"; readonly driverKind: string; readonly route: ProgramRoute }
  | {
      readonly kind: "peer";
      readonly driverKind: string;
      readonly peer: string;
      readonly route: ProgramRoute;
    };

export type EvaluatorKind = "program" | "worker" | "remote" | "peer";
export type SandboxIntent =
  | { readonly mode: "reuse"; readonly affinity: SandboxAffinity }
  | { readonly mode: "allocate" };

export interface LivePlacement {
  readonly route: PlacementRoute;
  readonly evaluatorKind: EvaluatorKind;
  readonly sandbox: SandboxIntent;
}

export type PlannedRowClassification =
  | "terminal"
  | "structurally_blocked"
  | "peer_hosted"
  | "replayable";

export interface PlannedForestRow {
  readonly address: TurnAddress;
  readonly strand: string;
  readonly head: StrandHead;
  readonly program: PinnedProgram;
  readonly classification: PlannedRowClassification;
  readonly parked?: { readonly pullId: string; readonly reason: string };
  readonly groupContext: ForkContext;
}

/** Runtime-only replay input. It deliberately carries no command capability. */
export interface ReplayItem {
  readonly address: TurnAddress;
  readonly strand: string;
  readonly plannedHead: StrandHead;
  readonly program: PinnedProgram;
  readonly input: Json;
  readonly route: ProgramRoute;
  readonly executionEpoch: number;
  readonly groupContext: ForkContext;
  readonly replay: readonly ReplayEntry[];
  readonly replayedThroughActionIndex: number;
  readonly replayChainSeed: string;
  readonly replayChainDigest: string;
}

export interface PeerReadyTarget {
  readonly address: TurnAddress;
  readonly strand: string;
  readonly evidenceHead: StrandHead;
  readonly groupContext: ForkContext;
  readonly deliveryCursor: { readonly correlator?: string };
}

export interface ForestReplayPlan {
  readonly sessionId: string;
  readonly forestRevision: number;
  readonly journalHeadDigest: string;
  readonly rows: readonly PlannedForestRow[];
  readonly replay: readonly ReplayItem[];
  readonly peers: readonly PeerReadyTarget[];
}

/** Replay output: frontier equals the immutable item head; still no live rights. */
export interface CaughtUpLeaf {
  readonly item: ReplayItem;
  readonly restored: RestoredProgramAttachment;
  readonly frontierProof: {
    readonly frontierDigest: string;
    readonly strandHeadDigest: string;
    readonly replayedThroughActionIndex: number;
    readonly replayChainDigest: string;
    readonly cancellationReplayed: boolean;
  };
}

export type PreparedTarget =
  | { readonly kind: "crank_native"; readonly caughtUp: CaughtUpLeaf }
  | { readonly kind: "peer_hosted"; readonly ready: PeerReadyTarget };

export interface AdvancementPlan {
  readonly target: PreparedTarget;
  readonly placement: LivePlacement;
}

export interface AttachmentIdentity {
  readonly attachmentId: string;
  readonly boundAtRevision: number;
}

export interface LeaseClaim {
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
}

/** Runtime-only bind result. This is the sole crank-native live envelope. */
export interface Mandate {
  readonly kind: "mandate";
  readonly address: TurnAddress;
  readonly strand: string;
  readonly program: PinnedProgram;
  readonly placement: LivePlacement;
  readonly attachment: AttachmentIdentity;
  readonly groupContext: ForkContext;
  readonly lease: LeaseClaim;
  readonly boundFrontier: CaughtUpLeaf["frontierProof"];
  readonly programCapability: string;
}

/** Runtime-only peer bind. It has delivery proposal rights, never program rights. */
export interface DeliveryMandate {
  readonly kind: "delivery_mandate";
  readonly address: TurnAddress;
  readonly strand: string;
  readonly placement: LivePlacement;
  readonly attachment: AttachmentIdentity;
  readonly groupContext: ForkContext;
  readonly lease: LeaseClaim;
  readonly boundFrontier: {
    readonly strandHeadDigest: string;
    readonly groupRevision: number;
  };
  readonly deliveryCursor: PeerReadyTarget["deliveryCursor"];
  readonly deliveryCapability: string;
}

/** Runtime holder used only to make the attachment lifetime explicit. */
export interface BoundAttachment {
  readonly attachment: ProgramAttachment;
  readonly mandate: Mandate;
}
