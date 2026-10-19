import type { DecisionDraft } from "../decisions/decision-draft.ts";
import type { DraftTask } from "../decisions/decision-state.ts";

/** Ends one task-scoped Mandate lease in the same commit as its boundary. */
export function endLiveLease(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  reason: "parked" | "settled" | "terminal" | "failed" | "scope_exit",
): void {
  const lease = task.execution.liveLease;
  if (lease === undefined) {
    return;
  }
  delete task.execution.liveLease;
  draft.append(sessionId, lease.epoch, {
    type: "AdvancementReleased",
    taskId: task.taskId,
    leaseEpoch: lease.epoch,
    reason,
  });
  draft.session(sessionId).control.runnable = reason === "settled" || reason === "failed";
}
