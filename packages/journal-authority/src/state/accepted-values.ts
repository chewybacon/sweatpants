import type { TaskState, ActionState } from "../contract/authority-contract.ts";

// Program identity, manifest and input never change after task admission.
// Only schema-validated, deeply frozen values enter this weak identity set.
const accepted = new WeakSet<object>();
const settledActions = new WeakSet<object>();
const pullRequests = new WeakSet<object>();
const bounds = new WeakMap<object, { nodes: number; depth: number }>();

export function isAcceptedProgram(value: unknown): boolean {
  return typeof value === "object" && value !== null && accepted.has(value);
}

export function retainParsedProgram<T extends object>(program: T): T {
  retainParsedValue(program);
  accepted.add(program);
  return program;
}

/** Schema-owned immutable data retains its aggregate bounds as well as its value. */
export function retainParsedValue<T extends object>(value: T): T {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let depth = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes++;
    depth = Math.max(depth, current.depth);
    if (current.value === null || typeof current.value !== "object") continue;
    for (const child of Object.values(current.value))
      pending.push({ value: child, depth: current.depth + 1 });
    Object.freeze(current.value);
  }
  bounds.set(value, { nodes, depth });
  return value;
}

export function retainedValueBounds(value: object) {
  return bounds.get(value);
}

export function isAcceptedAction(value: unknown): boolean {
  return typeof value === "object" && value !== null && settledActions.has(value);
}

export function isAcceptedPullRequest(value: unknown): boolean {
  return typeof value === "object" && value !== null && pullRequests.has(value);
}

export function retainParsedPullRequest<T extends object>(request: T): T {
  retainParsedValue(request);
  pullRequests.add(request);
  return request;
}

export function retainParsedAction<
  T extends { kind: string; pull?: { resolution: { status: string } } },
>(action: T): T {
  if (action.kind === "emission" || action.pull?.resolution.status === "settled") {
    retainParsedValue(action);
    settledActions.add(action);
  }
  return action;
}

/** Mutable task fields belong to each draft; admitted program data can be shared. */
export function cloneTaskState(task: TaskState): TaskState {
  const { program, actions, ...mutable } = task;
  return {
    ...structuredClone(mutable),
    program: isAcceptedProgram(program) ? program : structuredClone(program),
    actions: actions.map(cloneAction),
  };
}

function cloneAction(action: ActionState): ActionState {
  if (isAcceptedAction(action)) return action;
  if (action.kind !== "pull" || !isAcceptedPullRequest(action.pull.request))
    return structuredClone(action);
  const { request, ...mutable } = action.pull;
  return { ...action, pull: { ...structuredClone(mutable), request } };
}
