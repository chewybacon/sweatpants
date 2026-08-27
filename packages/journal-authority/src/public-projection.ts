import type {
  ForestReplayPlan,
  PlannedForestRow,
  TurnAddress,
} from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "./semantic-record.ts";

export interface ProjectionPolicy {
  /** Product-owned decision; kernel audiences are not implicitly public. */
  readonly participantAddressable: (candidate: {
    readonly address: TurnAddress;
    readonly pullId: string;
    readonly reason: string;
    readonly audience: string;
  }) => boolean;
}

export interface PublicOpenSlot {
  readonly address: TurnAddress;
  readonly pullId: string;
  readonly reason: string;
  readonly audience: string;
}

export interface PublicTaskProjection {
  readonly address: TurnAddress;
  readonly state: PlannedForestRow["classification"];
  /** Derived only from TaskOpened lineage records, never descriptor claims. */
  readonly parentTaskId?: string;
  readonly detachedLegacy: boolean;
}

export interface DurableExecutionProjection {
  readonly forestRevision: number;
  readonly journalHeadDigest: string;
  readonly tasks: readonly PublicTaskProjection[];
  readonly openSlots: readonly PublicOpenSlot[];
}

/**
 * Deterministic, bounded, read-only projection (REQ-028/048..051).
 *
 * The function has no Authority port and accepts only immutable plan/record
 * values plus explicit product policy. Runtime artifacts and capabilities are
 * absent by type. At most one slot is emitted per planned row.
 */
export function projectDurableExecution(
  plan: ForestReplayPlan,
  records: readonly DurableSemanticRecord[],
  policy: ProjectionPolicy,
): DurableExecutionProjection {
  const lineage = new Map<string, string | undefined>();
  const detachedLegacy = new Set<string>();
  const spawnPulls = new Set(
    records
      .filter(
        (record) =>
          record.payload.type === "PullRequested" && record.payload.descriptor.kind === "spawn",
      )
      .map((record) => (record.payload.type === "PullRequested" ? record.payload.pullId : "")),
  );
  for (const record of records) {
    if (record.payload.type !== "TaskOpened") continue;
    lineage.set(record.payload.taskId, record.payload.parentTaskId);
    if (record.payload.parentPullId !== undefined && spawnPulls.has(record.payload.parentPullId)) {
      detachedLegacy.add(record.payload.taskId);
    }
  }

  const tasks = plan.rows.map(
    (row): PublicTaskProjection => ({
      address: row.address,
      state: row.classification,
      ...(lineage.get(row.address.taskId) === undefined
        ? {}
        : { parentTaskId: lineage.get(row.address.taskId)! }),
      detachedLegacy: detachedLegacy.has(row.address.taskId),
    }),
  );
  const openSlots: PublicOpenSlot[] = [];
  for (const row of plan.rows) {
    if (row.parked === undefined) continue;
    const candidate = {
      address: row.address,
      pullId: row.parked.pullId,
      reason: row.parked.reason,
      audience: row.parked.audience,
    };
    if (policy.participantAddressable(candidate)) openSlots.push(candidate);
  }
  return {
    forestRevision: plan.forestRevision,
    journalHeadDigest: plan.journalHeadDigest,
    tasks,
    openSlots,
  };
}
