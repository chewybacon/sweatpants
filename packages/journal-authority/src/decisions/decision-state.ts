import { CrankError } from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { DraftForkGroup } from "../forest/fork-group.ts";
import type { DurableCancellationState } from "../contract/authority-types.ts";
import type {
  ActionState,
  AuthoritySessionState,
  AuthorityState,
  PullState,
  TaskState,
} from "../contract/authority-contract.ts";

export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends ReadonlyMap<infer K, infer V>
    ? Map<K, DeepMutable<V>>
    : T extends object
      ? { -readonly [P in keyof T]: DeepMutable<T[P]> }
      : T;
export type DraftPull = Omit<DeepMutable<PullState>, "request" | "resolution" | "acceptedFacts"> & {
  readonly request: PullState["request"];
  resolution: PullState["resolution"];
  acceptedFacts: {
    -readonly [K in keyof PullState["acceptedFacts"]]: PullState["acceptedFacts"][K];
  };
};
type DraftAction =
  | Extract<ActionState, { kind: "emission" }>
  | (Omit<Extract<ActionState, { kind: "pull" }>, "pull"> & { readonly pull: DraftPull });
export type DraftTask = Omit<
  DeepMutable<TaskState>,
  "program" | "actions" | "execution" | "lifecycle" | "forkGroup"
> & {
  execution: Omit<DeepMutable<TaskState["execution"]>, "catalog" | "route"> & {
    readonly catalog?: TaskState["execution"]["catalog"];
    readonly route?: TaskState["execution"]["route"];
  };
  lifecycle:
    | DeepMutable<Extract<TaskState["lifecycle"], { status: "active" }>>
    | Exclude<TaskState["lifecycle"], { status: "active" }>;
  forkGroup?: DraftForkGroup;
  readonly program: TaskState["program"];
  actions: DraftAction[];
};
export interface DraftSession {
  control: DeepMutable<AuthoritySessionState["control"]>;
  execution: { tasks: Map<string, TaskState> };
}
export interface DraftState {
  nextNonce: number;
  sessions: Map<string, AuthoritySessionState>;
}

/** Accepted program identity/input and pull requests never change after admission.
 * Drafts copy mutable fields, sharing immutable owned data without registration.
 */
export function cloneTaskState(task: TaskState): DraftTask {
  const { program, actions, execution, lifecycle, forkGroup, ...mutable } = task;
  return {
    ...structuredClone(mutable),
    forkGroup: forkGroup && {
      ...forkGroup,
      policy: { ...forkGroup.policy },
      winner: forkGroup.winner && { ...forkGroup.winner },
      members: forkGroup.members.map((member) => ({ ...member })),
    },
    execution: { ...execution, liveLease: execution.liveLease && { ...execution.liveLease } },
    lifecycle: lifecycle.status === "active" ? structuredClone(lifecycle) : lifecycle,
    program,
    actions: actions.map((action) => {
      if (action.kind === "emission") {
        return action;
      }
      const pull = action.pull;
      return {
        ...action,
        pull: {
          ...pull,
          resolutionAuthority: { ...pull.resolutionAuthority },
          attempts: pull.attempts.map((attempt) => ({ ...attempt })),
          acceptedFacts: { ...pull.acceptedFacts },
        },
      };
    }),
  } as DraftTask;
}

export function taskOriginSession(state: AuthorityState, taskId: string): string {
  for (const [sessionId, session] of state.sessions) {
    if (session.execution.tasks.has(taskId)) {
      return sessionId;
    }
  }
  throw new CrankError("unknown_target", `Unknown task ${taskId}`);
}

export function taskFor(state: AuthorityState, sessionId: string, taskId: string): TaskState {
  const task = state.sessions.get(sessionId)?.execution.tasks.get(taskId);
  if (task === undefined) {
    throw new CrankError("unknown_target", `Unknown task ${taskId}`);
  }
  return task;
}

export function pullByAction(task: DraftTask, actionIndex: number): DraftPull | undefined;
export function pullByAction(task: TaskState, actionIndex: number): PullState | undefined;
export function pullByAction(task: TaskState, actionIndex: number): PullState | undefined {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.actionIndex === actionIndex,
  );
  return action?.kind === "pull" ? action.pull : undefined;
}

export function pullById(task: DraftTask, pullId: string): DraftPull;
export function pullById(task: TaskState, pullId: string): PullState;
export function pullById(task: TaskState, pullId: string): PullState {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
  );
  if (action?.kind !== "pull") {
    throw new CrankError("pull_not_found");
  }
  return action.pull;
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
): [string, TaskState, PullState] | undefined {
  for (const [sessionId, session] of state.sessions) {
    const task = session.execution.tasks.get(taskId);
    if (task === undefined) {
      continue;
    }
    const action = task.actions.find(
      (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
    );
    if (action?.kind === "pull") {
      return [sessionId, task, action.pull];
    }
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
): [string, TaskState, PullState] | undefined {
  for (const [sessionId, session] of state.sessions) {
    for (const task of session.execution.tasks.values()) {
      for (const action of task.actions) {
        if (action.kind === "pull" && action.pull.pullId === pullId) {
          return [sessionId, task, action.pull];
        }
      }
    }
  }
  return undefined;
}
