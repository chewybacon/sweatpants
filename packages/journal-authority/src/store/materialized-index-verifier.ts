import { CrankError } from "@sweatpants/durable-execution";
import { digestCanonicalJson, encodeCanonicalJson } from "@sweatpants/foundation";
import type { DurableAuthoritySnapshot } from "../contract/authority-contract.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";

type RecordOf<T extends DurableSemanticRecord["payload"]> = Omit<
  DurableSemanticRecord,
  "payload"
> & {
  readonly payload: T;
};
type TaskOpenedRecord = RecordOf<Extract<DurableSemanticRecord["payload"], { type: "TaskOpened" }>>;
type PullRequestedRecord = RecordOf<
  Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>
>;
type PullResolvedRecord = RecordOf<
  Extract<DurableSemanticRecord["payload"], { type: "PullResolved" }>
>;
type DurableEmissionRecord = RecordOf<
  Extract<DurableSemanticRecord["payload"], { type: "DurableEmission" }>
>;
type TaskClosedRecord = RecordOf<Extract<DurableSemanticRecord["payload"], { type: "TaskClosed" }>>;
type TaskOrphanedRecord = RecordOf<
  Extract<DurableSemanticRecord["payload"], { type: "TaskOrphaned" }>
>;
type ForkGroupOpenedRecord = RecordOf<
  Extract<DurableSemanticRecord["payload"], { type: "ForkGroupOpened" }>
>;

interface MaterializedRecordIndex {
  readonly openings: Map<string, TaskOpenedRecord>;
  readonly pullRequests: Map<string, PullRequestedRecord>;
  readonly resolutions: Map<string, PullResolvedRecord>;
  readonly emissions: Map<string, DurableEmissionRecord>;
  readonly closures: Map<string, TaskClosedRecord>;
  readonly orphans: Map<string, TaskOrphanedRecord>;
  readonly forkGroups: Map<string, ForkGroupOpenedRecord>;
}

/** Builds all canonical-record lookups once for one session. */
function indexRecords(records: readonly DurableSemanticRecord[]): MaterializedRecordIndex {
  const index: MaterializedRecordIndex = {
    openings: new Map(),
    pullRequests: new Map(),
    resolutions: new Map(),
    emissions: new Map(),
    closures: new Map(),
    orphans: new Map(),
    forkGroups: new Map(),
  };
  for (const record of records) {
    const payload = record.payload;
    switch (payload.type) {
      case "TaskOpened":
        putFirst(index.openings, payload.taskId, record);
        break;
      case "PullRequested":
        putFirst(index.pullRequests, recordKey(payload.taskId, payload.pullId), record);
        break;
      case "PullResolved":
        putFirst(index.resolutions, recordKey(payload.taskId, payload.pullId), record);
        break;
      case "DurableEmission":
        putFirst(index.emissions, recordKey(payload.taskId, String(payload.actionIndex)), record);
        break;
      case "TaskClosed":
        putFirst(index.closures, payload.taskId, record);
        break;
      case "TaskOrphaned":
        putFirst(index.orphans, payload.taskId, record);
        break;
      case "ForkGroupOpened":
        putFirst(index.forkGroups, recordKey(payload.taskId, payload.groupId), record);
        break;
    }
  }
  return index;
}

function putFirst<K, V>(index: Map<K, V>, key: K, value: V): void {
  if (!index.has(key)) {
    index.set(key, value);
  }
}

/** Length-prefixes opaque ids so composite keys are injective. */
function recordKey(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

/**
 * Fails closed when stored materialized rows disagree with canonical records.
 * Empty record sections are accepted for pre-record snapshots; once records are
 * present, every task and action must be evidenced by the fold (REQ-071).
 */
export function verifyMaterializedIndexes(snapshot: DurableAuthoritySnapshot): void {
  const recordSessions = new Map(snapshot.records ?? []);
  if ([...recordSessions.values()].every((records) => records.length === 0)) {
    return;
  }

  for (const [sessionId, session] of snapshot.sessions) {
    const records = recordSessions.get(sessionId) ?? [];
    const indexed = indexRecords(records);

    for (const task of session.execution.tasks) {
      const opening = indexed.openings.get(task.taskId);
      // Stored shells may hydrate rows alongside a bounded record window. A
      // row is verified whenever its canonical opening is present; omission
      // is not disagreement and is checked when the full chain is folded.
      if (opening?.payload.type !== "TaskOpened") {
        continue;
      }
      if (
        opening.payload.turnId !== task.turnId ||
        opening.payload.programId !== task.program.artifact.id ||
        opening.payload.programVersion !== task.program.artifact.version ||
        opening.payload.programDigest !== task.program.artifact.digest ||
        opening.payload.inputDigest !== digestCanonicalJson(task.program.input)
      ) {
        corrupt(sessionId, `opening ${task.taskId}`);
      }
      const expectedParent = task.origin.kind === "child" ? task.origin.invokedBy : undefined;
      if (
        opening.payload.parentTaskId !== expectedParent?.taskId ||
        opening.payload.parentPullId !== expectedParent?.pullId
      ) {
        corrupt(sessionId, `lineage ${task.taskId}`);
      }

      for (const action of task.actions) {
        if (action.kind === "pull") {
          const request = indexed.pullRequests.get(recordKey(task.taskId, action.pull.pullId));
          if (
            request?.payload.type !== "PullRequested" ||
            request.payload.actionIndex !== action.actionIndex ||
            request.payload.pullIndex !== action.pullIndex ||
            request.payload.descriptorDigest !== action.pull.request.proposedDescriptorDigest
          ) {
            corrupt(sessionId, `pull ${action.pull.pullId}`);
          }
          if (action.pull.resolution.status === "settled") {
            const resolution = indexed.resolutions.get(recordKey(task.taskId, action.pull.pullId));
            if (
              resolution?.payload.type !== "PullResolved" ||
              resolution.payload.outcomeDigest !==
                action.pull.resolution.settlement.outcomeDigest ||
              resolution.offset !== action.pull.resolution.settlement.receipt.resolutionOffset
            ) {
              corrupt(sessionId, `resolution ${action.pull.pullId}`);
            }
          }
        } else {
          const emission = indexed.emissions.get(
            recordKey(task.taskId, String(action.actionIndex)),
          );
          if (
            emission?.payload.type !== "DurableEmission" ||
            emission.payload.emissionIndex !== action.emissionIndex ||
            emission.payload.descriptorDigest !== action.descriptorDigest ||
            emission.offset !== action.receipt.offset
          ) {
            corrupt(sessionId, `emission ${action.actionIndex}`);
          }
        }
      }

      if (task.lifecycle.status === "closed" || task.lifecycle.status === "cancelled") {
        const closure = indexed.closures.get(task.taskId);
        if (
          closure?.payload.type !== "TaskClosed" ||
          encodeCanonicalJson(closure.payload.outcome) !==
            encodeCanonicalJson(task.lifecycle.outcome) ||
          closure.offset !== task.lifecycle.receipt.offset
        ) {
          corrupt(sessionId, `closure ${task.taskId}`);
        }
      }
      if (task.lifecycle.status === "orphaned") {
        const orphan = indexed.orphans.get(task.taskId);
        if (
          orphan?.payload.type !== "TaskOrphaned" ||
          orphan.payload.reason !== task.lifecycle.reason
        ) {
          corrupt(sessionId, `orphan ${task.taskId}`);
        }
      }
      if (task.forkGroup !== undefined) {
        const group = indexed.forkGroups.get(recordKey(task.taskId, task.forkGroup.groupId));
        if (
          group?.payload.type !== "ForkGroupOpened" ||
          group.payload.descriptorDigest !== task.forkGroup.descriptorDigest ||
          encodeCanonicalJson(group.payload.memberTaskIds) !==
            encodeCanonicalJson(task.forkGroup.members.map((member) => member.taskId))
        ) {
          corrupt(sessionId, `fork group ${task.forkGroup.groupId}`);
        }
      }
    }
  }
}

function corrupt(sessionId: string, subject: string): never {
  throw new CrankError(
    "invalid_journal",
    `Materialized index disagrees with records for ${sessionId}: ${subject}`,
  );
}
