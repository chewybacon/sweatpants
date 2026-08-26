import { CrankError } from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { DurableCancellationState } from "./authority-types.ts";
import type {
  ActionState,
  AuthoritySessionState,
  AuthorityState,
  PullState,
  TaskState,
} from "./authority-contract.ts";

export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends ReadonlyMap<infer K, infer V>
    ? Map<K, DeepMutable<V>>
    : T extends object
      ? { -readonly [P in keyof T]: DeepMutable<T[P]> }
      : T;
export type DraftTask = DeepMutable<TaskState>;
export type DraftSession = DeepMutable<AuthoritySessionState>;
export type DraftState = DeepMutable<AuthorityState>;
export type DraftPull = DeepMutable<PullState>;

export function cloneAuthorityState(state: AuthorityState): DraftState {
  return structuredClone(state) as unknown as DraftState;
}

export function taskOriginSession(state: AuthorityState, taskId: string): string {
  for (const [sessionId, session] of state.sessions) {
    if (session.execution.tasks.has(taskId)) return sessionId;
  }
  throw new CrankError("unknown_target", `Unknown task ${taskId}`);
}

export function taskFor(state: AuthorityState, sessionId: string, taskId: string): TaskState {
  const task = state.sessions.get(sessionId)?.execution.tasks.get(taskId);
  if (task === undefined) throw new CrankError("unknown_target", `Unknown task ${taskId}`);
  return task;
}

export function pullByAction(task: TaskState, actionIndex: number): DraftPull | undefined {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.actionIndex === actionIndex,
  );
  return action?.kind === "pull" ? (action.pull as DraftPull) : undefined;
}

export function pullById(task: TaskState, pullId: string): DraftPull {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
  );
  if (action?.kind !== "pull") throw new CrankError("pull_not_found");
  return action.pull as DraftPull;
}

export function pullActionIndex(task: TaskState, pull: PullState): number {
  return (
    task.actions.find(
      (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pull.pullId,
    )?.actionIndex ?? -1
  );
}

export function emissionByAction(
  task: TaskState,
  actionIndex: number,
): Extract<ActionState, { kind: "emission" }> | undefined {
  const action = task.actions.find(
    (candidate) => candidate.kind === "emission" && candidate.actionIndex === actionIndex,
  );
  return action?.kind === "emission" ? action : undefined;
}

export function currentAttempt(pull: PullState) {
  return [...pull.attempts]
    .filter((attempt) => attempt.status === "started")
    .sort((left, right) => right.attemptIndex - left.attemptIndex)[0];
}

export function pullAudience(pull: PullState): string {
  return pull.resolutionAuthority.audience;
}

export function findTaskPullById(
  state: AuthorityState,
  taskId: string,
  pullId: string,
): [string, DraftTask, DraftPull] | undefined {
  for (const [sessionId, session] of state.sessions) {
    const task = session.execution.tasks.get(taskId);
    if (task === undefined) continue;
    const action = task.actions.find(
      (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
    );
    if (action?.kind === "pull") return [sessionId, task as DraftTask, action.pull as DraftPull];
  }
  return undefined;
}

export function terminalOutcome(task: TaskState): OperationOutcome | undefined {
  return task.lifecycle.status === "closed" || task.lifecycle.status === "cancelled"
    ? task.lifecycle.outcome
    : undefined;
}

export function terminalCancellation(task: TaskState): DurableCancellationState {
  if (task.lifecycle.status === "cancelled") {
    return { type: "cancelled", commandId: task.lifecycle.commandId };
  }
  if (task.lifecycle.status === "orphaned") {
    return { type: "orphaned", reason: task.lifecycle.reason };
  }
  return { type: "none" };
}

export function findPullById(
  state: AuthorityState,
  pullId: string,
): [string, DraftTask, DraftPull] | undefined {
  for (const [sessionId, session] of state.sessions) {
    for (const task of session.execution.tasks.values()) {
      for (const action of task.actions) {
        if (action.kind === "pull" && action.pull.pullId === pullId) {
          return [sessionId, task as DraftTask, action.pull as DraftPull];
        }
      }
    }
  }
  return undefined;
}
