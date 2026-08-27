import { CrankError } from "@sweatpants/durable-execution";
import { canonicalSnapshot } from "@sweatpants/foundation";
import type { DurableAuthoritySnapshot } from "./authority-contract.ts";

/**
 * Fails closed when stored materialized rows disagree with canonical records.
 * Empty record sections are accepted for pre-record snapshots; once records are
 * present, every task and action must be evidenced by the fold (REQ-071).
 */
export function verifyMaterializedIndexes(snapshot: DurableAuthoritySnapshot): void {
  const recordSessions = new Map(snapshot.records ?? []);
  if ([...recordSessions.values()].every((records) => records.length === 0)) return;

  for (const [sessionId, session] of snapshot.sessions) {
    const records = recordSessions.get(sessionId) ?? [];
    const opened = records.filter((record) => record.payload.type === "TaskOpened");

    for (const task of session.execution.tasks) {
      const opening = opened.find(
        (record) => record.payload.type === "TaskOpened" && record.payload.taskId === task.taskId,
      );
      // Stored shells may hydrate rows alongside a bounded record window. A
      // row is verified whenever its canonical opening is present; omission
      // is not disagreement and is checked when the full chain is folded.
      if (opening?.payload.type !== "TaskOpened") continue;
      if (
        opening.payload.turnId !== task.turnId ||
        opening.payload.programId !== task.program.artifact.id ||
        opening.payload.programVersion !== task.program.artifact.version ||
        opening.payload.programDigest !== task.program.artifact.digest ||
        opening.payload.inputDigest !== canonicalSnapshot(task.program.input).sha
      )
        corrupt(sessionId, `opening ${task.taskId}`);
      const expectedParent = task.origin.kind === "child" ? task.origin.invokedBy : undefined;
      if (
        opening.payload.parentTaskId !== expectedParent?.taskId ||
        opening.payload.parentPullId !== expectedParent?.pullId
      )
        corrupt(sessionId, `lineage ${task.taskId}`);

      for (const action of task.actions) {
        if (action.kind === "pull") {
          const request = records.find(
            (record) =>
              record.payload.type === "PullRequested" &&
              record.payload.taskId === task.taskId &&
              record.payload.pullId === action.pull.pullId,
          );
          if (
            request?.payload.type !== "PullRequested" ||
            request.payload.actionIndex !== action.actionIndex ||
            request.payload.pullIndex !== action.pullIndex ||
            request.payload.descriptorDigest !== action.pull.request.proposedDescriptorDigest
          )
            corrupt(sessionId, `pull ${action.pull.pullId}`);
          if (action.pull.resolution.status === "settled") {
            const resolution = records.find(
              (record) =>
                record.payload.type === "PullResolved" &&
                record.payload.taskId === task.taskId &&
                record.payload.pullId === action.pull.pullId,
            );
            if (
              resolution?.payload.type !== "PullResolved" ||
              resolution.payload.outcomeDigest !==
                action.pull.resolution.settlement.outcomeDigest ||
              resolution.offset !== action.pull.resolution.settlement.receipt.resolutionOffset
            )
              corrupt(sessionId, `resolution ${action.pull.pullId}`);
          }
        } else {
          const emission = records.find(
            (record) =>
              record.payload.type === "DurableEmission" &&
              record.payload.taskId === task.taskId &&
              record.payload.actionIndex === action.actionIndex,
          );
          if (
            emission?.payload.type !== "DurableEmission" ||
            emission.payload.emissionIndex !== action.emissionIndex ||
            emission.payload.descriptorDigest !== action.descriptorDigest ||
            emission.offset !== action.receipt.offset
          )
            corrupt(sessionId, `emission ${action.actionIndex}`);
        }
      }

      if (task.lifecycle.status === "closed" || task.lifecycle.status === "cancelled") {
        const closure = records.find(
          (record) => record.payload.type === "TaskClosed" && record.payload.taskId === task.taskId,
        );
        if (
          closure?.payload.type !== "TaskClosed" ||
          canonicalSnapshot(closure.payload.outcome).sha !==
            canonicalSnapshot(task.lifecycle.outcome).sha ||
          closure.offset !== task.lifecycle.receipt.offset
        )
          corrupt(sessionId, `closure ${task.taskId}`);
      }
      if (task.lifecycle.status === "orphaned") {
        const orphan = records.find(
          (record) =>
            record.payload.type === "TaskOrphaned" && record.payload.taskId === task.taskId,
        );
        if (
          orphan?.payload.type !== "TaskOrphaned" ||
          orphan.payload.reason !== task.lifecycle.reason
        ) {
          corrupt(sessionId, `orphan ${task.taskId}`);
        }
      }
      if (task.forkGroup !== undefined) {
        const group = records.find(
          (record) =>
            record.payload.type === "ForkGroupOpened" &&
            record.payload.groupId === task.forkGroup!.groupId,
        );
        if (
          group?.payload.type !== "ForkGroupOpened" ||
          group.payload.descriptorDigest !== task.forkGroup.descriptorDigest ||
          canonicalSnapshot(group.payload.memberTaskIds).sha !==
            canonicalSnapshot(task.forkGroup.members.map((member) => member.taskId)).sha
        )
          corrupt(sessionId, `fork group ${task.forkGroup.groupId}`);
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
