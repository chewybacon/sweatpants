import { CrankError } from "@sweatpants/durable-execution";

import type {
  AuthoritySessionState,
  AuthorityState,
  DurableAuthoritySnapshot,
  TaskState,
} from "../contract/authority-contract.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import { verifyMaterializedIndexes } from "../store/materialized-index-verifier.ts";

/** Expands the sole direct snapshot format into grouped in-process state. */
export function authorityStateFromSnapshot(snapshot: DurableAuthoritySnapshot): AuthorityState {
  verifyMaterializedIndexes(snapshot);
  const sessions = new Map<string, AuthoritySessionState>();
  for (const [sessionId, value] of snapshot.sessions) {
    if (sessions.has(sessionId)) invalid(`Duplicate session ${sessionId}`);
    const headId = value.control.journalHeadId;
    if (
      (value.control.revision === 0 && headId !== null) ||
      (value.control.revision > 0 &&
        (typeof headId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(headId)))
    )
      invalid(`Session ${sessionId} has an invalid journal head identity`);
    const tasks = new Map<string, TaskState>();
    for (const task of value.execution.tasks) {
      if (tasks.has(task.taskId)) invalid(`Duplicate task ${task.taskId}`);
      validateTask(task);
      tasks.set(task.taskId, structuredClone(task));
    }
    sessions.set(sessionId, {
      execution: { tasks },
      control: structuredClone(value.control),
    });
  }
  return { sessions, nextNonce: snapshot.nextNonce };
}

/** Writes the direct current snapshot format. */
export function snapshotFromAuthorityState(
  state: AuthorityState,
  records: readonly [string, readonly DurableSemanticRecord[]][] = [],
): DurableAuthoritySnapshot {
  return {
    version: 1,
    sessions: [...state.sessions].map(([sessionId, session]) => [
      sessionId,
      {
        execution: {
          tasks: [...session.execution.tasks.values()].map((task) => structuredClone(task)),
        },
        control: structuredClone(session.control),
      },
    ]),
    nextNonce: state.nextNonce,
    records: records.map(([sessionId, entries]) => [sessionId, structuredClone([...entries])]),
  };
}

function validateTask(task: TaskState): void {
  if (
    task.origin.kind === "child" &&
    (!task.origin.invokedBy.taskId || !task.origin.invokedBy.pullId)
  ) {
    invalid(`Task ${task.taskId} has a partial parent origin`);
  }
  let pullIndex = 0;
  let emissionIndex = 0;
  for (const [actionIndex, action] of task.actions.entries()) {
    if (action.actionIndex !== actionIndex) invalid(`Task ${task.taskId} has an action gap`);
    if (action.kind === "pull") {
      if (action.pullIndex !== pullIndex++) invalid(`Task ${task.taskId} has a pull gap`);
      if (
        action.pull.resolution.status === "settled" &&
        action.pull.resolution.settlement.receipt.taskId !== task.taskId
      )
        invalid(`Task ${task.taskId} pull receipt differs`);
    } else if (action.emissionIndex !== emissionIndex++) {
      invalid(`Task ${task.taskId} has an emission gap`);
    }
  }
  // nextActionIndex is the program replay frontier: an open pull remains at
  // its action position until it settles, so it may be behind actions.length.
  if (task.nextActionIndex > task.actions.length || task.nextPullIndex < pullIndex) {
    invalid(`Task ${task.taskId} has an invalid action cursor`);
  }
}

function invalid(message: string): never {
  throw new CrankError("invalid_journal", message);
}
