import type {
  NormalizedProgramOperationTrace,
  NormalizedProgramTaskTrace,
  NormalizedProgramTrace,
} from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";

export function normalizeProgramTrace(
  records: readonly DurableSemanticRecord[],
): NormalizedProgramTrace {
  const tasks = new Map<string, NormalizedProgramTaskTrace>();
  const operationByPull = new Map<string, NormalizedProgramOperationTrace>();
  for (const record of records) {
    const payload = record.payload;
    if (payload.type === "TaskOpened") {
      tasks.set(payload.taskId, {
        taskId: payload.taskId,
        turnId: payload.turnId,
        /* CONDITIONAL-SPREAD: Omit absent parentTaskId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
        ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
        /* CONDITIONAL-SPREAD: Omit absent parentPullId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
        ...(payload.parentPullId ? { parentPullId: payload.parentPullId } : {}),
        program: {
          id: payload.programId,
          version: payload.programVersion,
          digest: payload.programDigest,
        },
        acceptedInput: payload.input,
        /* CONDITIONAL-SPREAD: Omit absent catalogDigest from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
        ...(payload.catalogDigest ? { catalogDigest: payload.catalogDigest } : {}),
        operations: [],
        semanticEmissions: [],
        cancellations: [],
      });
      continue;
    }
    if (payload.type === "PullRequested") {
      const operation = {
        actionIndex: payload.actionIndex,
        pullId: payload.pullId,
        descriptor: payload.descriptor,
      };
      tasks.get(payload.taskId)?.operations.push(operation);
      operationByPull.set(payload.pullId, operation);
      continue;
    }
    if (payload.type === "PullResolved") {
      const operation = operationByPull.get(payload.pullId);
      if (operation) {
        operation.outcome = payload.outcome;
      }
      continue;
    }
    if (payload.type === "DurableEmission") {
      tasks.get(payload.taskId)?.semanticEmissions.push(payload.descriptor);
      continue;
    }
    if (payload.type === "CancellationRequested") {
      tasks.get(payload.taskId)?.cancellations.push({
        taskId: payload.taskId,
        /* CONDITIONAL-SPREAD: Omit absent reason from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });
      continue;
    }
    if (payload.type === "TaskClosed") {
      const task = tasks.get(payload.taskId);
      if (task) {
        task.terminal = payload.outcome;
      }
    }
  }
  // Trace consumers own the returned report; journal values remain untouched.
  return structuredClone({ version: 1, tasks: [...tasks.values()] });
}
