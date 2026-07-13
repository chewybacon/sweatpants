import { assertJson, canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import {
  CrankError,
  type JournalRecord,
  type Json,
  type PullDescriptor,
  type Result,
  type SessionCommand,
} from "./types.ts";

export type IndexedPull = {
  request: Extract<JournalRecord["payload"], { type: "pull_requested" }>;
  resolution?: Extract<JournalRecord["payload"], { type: "pull_resolved" }>;
  attempts: Array<Extract<JournalRecord["payload"], { type: "attempt_started" }>>;
  abandoned: Set<string>;
};

export type ReplayIndex = {
  pulls: Map<string, IndexedPull[]>;
  closes: Map<string, Extract<JournalRecord["payload"], { type: "task_closed" }>>;
  taskOpens: Map<string, Extract<JournalRecord["payload"], { type: "task_opened" }>>;
  commands: Extract<JournalRecord["payload"], { type: "command" }>["command"][];
  consumedCommands: Set<string>;
};

type TaskValidation = {
  turnId: string;
  parent?: string;
  closed: boolean;
  nextChildOrdinal: number;
};

type AttemptValidation = {
  pullId: string;
  turnId: string;
  taskId: string;
  abandoned: boolean;
};

export function validateJournal(records: readonly JournalRecord[]): void {
  const eventIds = new Set<string>();
  const tasks = new Map<string, TaskValidation>();
  const requests = new Map<string, Extract<JournalRecord["payload"], { type: "pull_requested" }>>();
  const resolutions = new Set<string>();
  const attempts = new Map<string, AttemptValidation>();
  const sequences = new Map<string, number>();
  const commands = new Map<
    string,
    Extract<JournalRecord["payload"], { type: "command" }>["command"]
  >();
  const consumedCommands = new Set<string>();
  const openedChildren = new Map<string, string[]>();
  let turnCount = 0;
  let sessionId: string | undefined;
  let sessionClosed = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (
      record.offset !== index ||
      eventIds.has(record.eventId) ||
      record.eventId !== `journal:${record.sessionId}:${record.offset}`
    ) {
      invalid("offset/event identity");
    }
    if (sessionId !== undefined && sessionId !== record.sessionId) invalid("mixed session ids");
    sessionId = record.sessionId;
    eventIds.add(record.eventId);
    const payload = record.payload;
    if (payload.type !== "command" && record.ownerEpoch === undefined) {
      invalid("owner epoch missing");
    }
    if (payload.type === "command" && record.ownerEpoch !== undefined) {
      invalid("command on owner execution path");
    }
    if (sessionClosed) invalid("record after session close");

    switch (payload.type) {
      case "command": {
        validateSessionCommand(payload.command);
        if (
          commands.has(payload.command.commandId) ||
          payload.command.sessionId !== record.sessionId
        ) {
          invalid("invalid command identity");
        }
        commands.set(payload.command.commandId, payload.command);
        break;
      }
      case "turn_opened": {
        const command = commands.get(payload.commandId);
        if (
          command?.type !== "send" ||
          consumedCommands.has(payload.commandId) ||
          payload.turnSeq !== turnCount++ ||
          payload.turnId !== `turn-${payload.turnSeq}`
        ) {
          invalid("invalid turn command/sequence");
        }
        if (tasks.has(payload.taskId) || payload.taskId !== `${payload.turnId}/root`) {
          invalid("invalid root task");
        }
        if (canonicalSnapshot(payload.input).sha !== payload.inputSha) invalid("turn input hash");
        tasks.set(payload.taskId, {
          turnId: payload.turnId,
          closed: false,
          nextChildOrdinal: 0,
        });
        consumedCommands.add(payload.commandId);
        break;
      }
      case "task_opened": {
        const parent = tasks.get(payload.parentTaskId);
        const parentRequest = requests.get(payload.parentPullId);
        if (
          tasks.has(payload.taskId) ||
          !parent ||
          parent.closed ||
          !parentRequest ||
          parentRequest.taskId !== payload.parentTaskId ||
          parentRequest.turnId !== payload.turnId ||
          parent.turnId !== payload.turnId ||
          !["invoke", "all"].includes(parentRequest.descriptor.kind)
        ) {
          invalid("invalid child opening");
        }
        const childIndex = (openedChildren.get(payload.parentPullId) ?? []).length;
        const expectedChild = childDescriptor(parentRequest.descriptor, childIndex);
        if (
          !expectedChild ||
          payload.taskId !== `${payload.parentTaskId}.${parent.nextChildOrdinal}` ||
          payload.programId !== expectedChild.programId ||
          canonicalSnapshot(payload.input).sha !== payload.inputSha ||
          canonicalSnapshot(expectedChild.input).sha !== payload.inputSha
        ) {
          invalid("invalid child identity/input");
        }
        parent.nextChildOrdinal += 1;
        tasks.set(payload.taskId, {
          turnId: payload.turnId,
          parent: payload.parentTaskId,
          closed: false,
          nextChildOrdinal: 0,
        });
        openedChildren.set(payload.parentPullId, [
          ...(openedChildren.get(payload.parentPullId) ?? []),
          payload.taskId,
        ]);
        break;
      }
      case "pull_requested": {
        const task = tasks.get(payload.taskId);
        if (
          !task ||
          task.closed ||
          task.turnId !== payload.turnId ||
          requests.has(payload.pullId) ||
          payload.pullId !==
            stablePullId(record.sessionId, payload.turnId, payload.taskId, payload.pullIndex)
        ) {
          invalid("invalid pull request");
        }
        const taskPullCount = [...requests.values()].filter(
          (request) => request.taskId === payload.taskId,
        ).length;
        if (payload.pullIndex !== taskPullCount) invalid("non-contiguous pull index");
        if (descriptorFingerprint(payload.descriptor) !== payload.inputSha) {
          invalid("pull input hash");
        }
        requests.set(payload.pullId, payload);
        break;
      }
      case "pull_resolved": {
        const request = requests.get(payload.pullId);
        if (
          !request ||
          resolutions.has(payload.pullId) ||
          payload.turnId !== request.turnId ||
          payload.taskId !== request.taskId
        ) {
          invalid("invalid pull resolution");
        }
        if (payload.commandId) {
          const command = commands.get(payload.commandId);
          if (
            consumedCommands.has(payload.commandId) ||
            command?.type !== "respond" ||
            command.pullId !== payload.pullId ||
            request.descriptor.kind !== "elicit"
          ) {
            invalid("invalid response command reference");
          }
          consumedCommands.add(payload.commandId);
        }
        if (request.descriptor.kind === "invoke" || request.descriptor.kind === "all") {
          const opened = openedChildren.get(payload.pullId) ?? [];
          const expectedCount = childCount(request.descriptor);
          const unknownTarget =
            payload.result.status === "error" && payload.result.error.code === "unknown_target";
          if (!unknownTarget && opened.length !== expectedCount) {
            invalid("missing or extra child task");
          }
          if (opened.some((taskId) => !tasks.get(taskId)?.closed)) {
            invalid("parent resolved before child close");
          }
        }
        resolutions.add(payload.pullId);
        break;
      }
      case "attempt_started": {
        const request = requests.get(payload.pullId);
        if (
          !request ||
          resolutions.has(payload.pullId) ||
          !["effect", "record", "emit"].includes(request.descriptor.kind) ||
          attempts.has(payload.attemptId) ||
          payload.turnId !== request.turnId ||
          payload.taskId !== request.taskId ||
          payload.attemptId !== `${payload.pullId}:attempt-${payload.attemptIndex}`
        ) {
          invalid("invalid attempt start");
        }
        const count = [...attempts.values()].filter(
          (attempt) => attempt.pullId === payload.pullId,
        ).length;
        if (payload.attemptIndex !== count) invalid("attempt index");
        attempts.set(payload.attemptId, {
          pullId: payload.pullId,
          turnId: payload.turnId,
          taskId: payload.taskId,
          abandoned: false,
        });
        break;
      }
      case "attempt_abandoned": {
        const request = requests.get(payload.pullId);
        const attempt = attempts.get(payload.attemptId);
        if (
          !request ||
          !attempt ||
          attempt.pullId !== payload.pullId ||
          attempt.turnId !== payload.turnId ||
          attempt.taskId !== payload.taskId ||
          request.turnId !== payload.turnId ||
          request.taskId !== payload.taskId ||
          attempt.abandoned ||
          resolutions.has(payload.pullId)
        ) {
          invalid("invalid abandonment");
        }
        attempt.abandoned = true;
        break;
      }
      case "durable_emission": {
        const request = requests.get(payload.pullId);
        const attempt = attempts.get(payload.attemptId);
        if (
          !request ||
          !attempt ||
          attempt.pullId !== payload.pullId ||
          attempt.turnId !== payload.turnId ||
          attempt.taskId !== payload.taskId ||
          request.turnId !== payload.turnId ||
          request.taskId !== payload.taskId ||
          attempt.abandoned ||
          resolutions.has(payload.pullId)
        ) {
          invalid("invalid emission attempt");
        }
        const expected = sequences.get(payload.attemptId) ?? 0;
        if (payload.sequence !== expected) invalid("emission sequence");
        assertJson(payload.emission);
        sequences.set(payload.attemptId, expected + 1);
        break;
      }
      case "task_closed": {
        const task = tasks.get(payload.taskId);
        if (!task || task.closed || task.turnId !== payload.turnId) {
          invalid("duplicate/unknown task close");
        }
        if (payload.commandId) {
          const command = commands.get(payload.commandId);
          if (
            consumedCommands.has(payload.commandId) ||
            command?.type !== "cancel_turn" ||
            command.turnId !== payload.turnId ||
            payload.result.status !== "cancelled"
          ) {
            invalid("invalid cancellation command reference");
          }
          consumedCommands.add(payload.commandId);
        }
        if (
          [...tasks.values()].some(
            (candidate) => candidate.parent === payload.taskId && !candidate.closed,
          )
        ) {
          invalid("parent closed before child");
        }
        const unresolved = [...requests.values()].some(
          (request) => request.taskId === payload.taskId && !resolutions.has(request.pullId),
        );
        if (
          unresolved &&
          payload.result.status !== "diverged" &&
          payload.result.status !== "version_mismatch"
        ) {
          invalid("task closed with unresolved pull");
        }
        task.closed = true;
        break;
      }
      case "session_closed": {
        const command = commands.get(payload.commandId);
        if (
          command?.type !== "close_session" ||
          consumedCommands.has(payload.commandId) ||
          [...tasks.values()].some((task) => !task.closed)
        ) {
          invalid("invalid close command reference");
        }
        consumedCommands.add(payload.commandId);
        sessionClosed = true;
        break;
      }
      default:
        invalid("unknown event family");
    }
  }
}

export function buildReplayIndex(records: readonly JournalRecord[], turnId?: string): ReplayIndex {
  validateJournal(records);
  const pulls = new Map<string, IndexedPull[]>();
  const closes = new Map<string, Extract<JournalRecord["payload"], { type: "task_closed" }>>();
  const taskOpens = new Map<string, Extract<JournalRecord["payload"], { type: "task_opened" }>>();
  const commands: ReplayIndex["commands"] = [];
  const consumedCommands = new Set<string>();
  const byPullId = new Map<string, IndexedPull>();

  for (const record of records) {
    const payload = record.payload;
    if (payload.type === "command") commands.push(payload.command);
    if ("turnId" in payload && turnId !== undefined && payload.turnId !== turnId) continue;
    switch (payload.type) {
      case "pull_requested": {
        const indexed: IndexedPull = {
          request: payload,
          attempts: [],
          abandoned: new Set(),
        };
        const list = pulls.get(payload.taskId) ?? [];
        list.push(indexed);
        pulls.set(payload.taskId, list);
        byPullId.set(payload.pullId, indexed);
        break;
      }
      case "pull_resolved":
        byPullId.get(payload.pullId)!.resolution = payload;
        if (payload.commandId) consumedCommands.add(payload.commandId);
        break;
      case "attempt_started":
        byPullId.get(payload.pullId)!.attempts.push(payload);
        break;
      case "attempt_abandoned":
        byPullId.get(payload.pullId)!.abandoned.add(payload.attemptId);
        break;
      case "task_opened":
        taskOpens.set(payload.taskId, payload);
        break;
      case "task_closed":
        closes.set(payload.taskId, payload);
        if (payload.commandId) consumedCommands.add(payload.commandId);
        break;
      case "turn_opened":
      case "session_closed":
        consumedCommands.add(payload.commandId);
        break;
      case "durable_emission":
      case "command":
        break;
    }
  }
  return { pulls, closes, taskOpens, commands, consumedCommands };
}

export function descriptorFingerprint(descriptor: PullDescriptor): string {
  switch (descriptor.kind) {
    case "effect":
    case "elicit":
    case "record":
    case "invoke":
      return canonicalSnapshot(descriptor.input).sha;
    case "all":
      return canonicalSnapshot(descriptor.children as unknown).sha;
    case "emit":
      return canonicalSnapshot(descriptor.payload).sha;
  }
}

export function descriptorIdentity(descriptor: PullDescriptor): string {
  switch (descriptor.kind) {
    case "effect":
    case "elicit":
    case "record":
      return descriptor.effectId;
    case "invoke":
      return descriptor.programId;
    case "all":
      return descriptor.children.map((child) => child.programId).join(",");
    case "emit":
      return descriptor.eventType;
  }
}

export function resultEquals(left: Result, right: Result): boolean {
  return (
    canonicalSnapshot(left as unknown).canonical === canonicalSnapshot(right as unknown).canonical
  );
}

export function stablePullId(
  sessionId: string,
  turnId: string,
  taskId: string,
  pullIndex: number,
): string {
  return stableOpaqueId("pull", [sessionId, turnId, taskId, pullIndex]);
}

export function validateSessionCommand(command: SessionCommand): void {
  if (!command || typeof command !== "object") invalid("invalid command");
  assertJson(command);
  const keys = Object.keys(command).sort();
  const common = ["commandId", "sessionId", "type"];
  if (typeof command.sessionId !== "string" || command.sessionId.length === 0) {
    invalid("invalid command sessionId");
  }
  if (typeof command.commandId !== "string" || command.commandId.length === 0) {
    invalid("invalid command commandId");
  }
  switch (command.type) {
    case "send":
      exactKeys(keys, [...common, "message"].sort());
      assertJson(command.message);
      break;
    case "respond":
      exactKeys(keys, [...common, "pullId", "value"].sort());
      if (!command.pullId) invalid("invalid respond pullId");
      assertJson(command.value);
      break;
    case "cancel_turn":
      exactKeys(
        keys,
        [...common, "reason", "turnId"]
          .filter((key) => key !== "reason" || command.reason !== undefined)
          .sort(),
      );
      if (!command.turnId) invalid("invalid cancel turnId");
      if (command.reason !== undefined && typeof command.reason !== "string")
        invalid("invalid cancel reason");
      break;
    case "close_session":
      exactKeys(
        keys,
        [...common, "reason"]
          .filter((key) => key !== "reason" || command.reason !== undefined)
          .sort(),
      );
      if (command.reason !== undefined && typeof command.reason !== "string")
        invalid("invalid close reason");
      break;
    default:
      invalid("unknown command type");
  }
}

function childDescriptor(
  descriptor: PullDescriptor,
  index: number,
): { programId: string; input: Json } | undefined {
  if (descriptor.kind === "invoke") {
    return index === 0 ? { programId: descriptor.programId, input: descriptor.input } : undefined;
  }
  if (descriptor.kind === "all") return descriptor.children[index];
  return undefined;
}

function childCount(descriptor: PullDescriptor): number {
  if (descriptor.kind === "invoke") return 1;
  if (descriptor.kind === "all") return descriptor.children.length;
  return 0;
}

function exactKeys(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid("invalid command fields");
  }
}

function invalid(message: string): never {
  throw new CrankError("invalid_journal", message);
}
