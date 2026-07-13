import { action, resource, type Operation, type Stream } from "effection";

import { canonicalJson } from "./canonical.ts";
import { validateJournal, validateSessionCommand } from "./journal.ts";
import {
  CrankError,
  type AppendExecutionResult,
  type ClaimResult,
  type CommandAck,
  type CoordinationRecord,
  type CrankStore,
  type ExecutionJournalPayload,
  type JournalPayload,
  type JournalRecord,
  type Lease,
  type ReleaseResult,
  type SessionCommand,
} from "./types.ts";

export type InMemoryCrankStoreOptions = {
  now?: () => number;
  maxCommandBytes?: number;
  maxRecordBytes?: number;
};

type State = {
  records: JournalRecord[];
  coordination: CoordinationRecord;
  commandOffsets: Map<string, number>;
  commandCanonical: Map<string, string>;
  waiters: Set<() => void>;
};

export class InMemoryCrankStore implements CrankStore {
  readonly #sessions = new Map<string, State>();
  readonly #now: () => number;
  readonly #maxCommandBytes: number;
  readonly #maxRecordBytes: number;

  constructor(options: InMemoryCrankStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxCommandBytes = options.maxCommandBytes ?? 1024 * 1024;
    this.#maxRecordBytes = options.maxRecordBytes ?? 4 * 1024 * 1024;
  }

  *ensureSession(sessionId: string): Operation<void> {
    this.#state(sessionId);
  }

  *readJournal(sessionId: string): Operation<JournalRecord[]> {
    return clone(this.#state(sessionId).records);
  }

  *coordination(sessionId: string): Operation<CoordinationRecord> {
    return clone(this.#state(sessionId).coordination);
  }

  *claim(sessionId: string, ownerId: string, leaseMs = 30_000): Operation<ClaimResult> {
    const state = this.#state(sessionId);
    const coordination = state.coordination;
    if (coordination.phase === "closed") return { status: "closed" };
    const now = this.#now();
    const leaseActive =
      coordination.ownerId !== undefined &&
      coordination.leaseExpiresAt !== undefined &&
      Date.parse(coordination.leaseExpiresAt) > now;
    if (leaseActive) return { status: "busy" };
    coordination.epoch += 1;
    coordination.ownerId = ownerId;
    coordination.leaseExpiresAt = new Date(now + leaseMs).toISOString();
    coordination.phase = "running";
    coordination.runnable = false;
    return {
      sessionId,
      ownerId,
      epoch: coordination.epoch,
      leaseExpiresAt: coordination.leaseExpiresAt,
    };
  }

  *renewLease(lease: Lease, leaseMs = 30_000): Operation<Lease | { status: "fenced" }> {
    const state = this.#state(lease.sessionId);
    if (!owns(state.coordination, lease, this.#now())) return { status: "fenced" };
    const leaseExpiresAt = new Date(this.#now() + leaseMs).toISOString();
    state.coordination.leaseExpiresAt = leaseExpiresAt;
    return { ...lease, leaseExpiresAt };
  }

  *appendCommand(command: SessionCommand): Operation<CommandAck> {
    try {
      validateSessionCommand(command);
    } catch {
      return { status: "rejected", commandId: command.commandId, code: "invalid_command" };
    }
    const state = this.#state(command.sessionId);
    const canonical = canonicalJson(command as unknown as never);
    if (Buffer.byteLength(canonical) > this.#maxCommandBytes) {
      return { status: "rejected", commandId: command.commandId, code: "payload_too_large" };
    }
    const previous = state.commandCanonical.get(command.commandId);
    if (previous !== undefined) {
      if (previous !== canonical)
        return { status: "rejected", commandId: command.commandId, code: "idempotency_conflict" };
      return {
        status: "duplicate",
        commandId: command.commandId,
        offset: state.commandOffsets.get(command.commandId)!,
      };
    }
    if (state.coordination.phase === "closed" || hasSessionClose(state.records)) {
      return { status: "rejected", commandId: command.commandId, code: "session_closed" };
    }
    const pendingClose = unconsumedCommand(state.records, "close_session");
    if (pendingClose) {
      return { status: "rejected", commandId: command.commandId, code: "session_closed" };
    }

    if (command.type === "respond") {
      const request = state.records.find(
        (
          record,
        ): record is JournalRecord & {
          payload: Extract<JournalPayload, { type: "pull_requested" }>;
        } => record.payload.type === "pull_requested" && record.payload.pullId === command.pullId,
      );
      if (!request || request.sessionId !== command.sessionId) {
        return { status: "not_pending", commandId: command.commandId, reason: "unknown" };
      }
      if (request.payload.descriptor.kind !== "elicit") {
        return { status: "not_pending", commandId: command.commandId, reason: "wrong_kind" };
      }
      if (
        state.records.some(
          (record) =>
            record.payload.type === "pull_resolved" && record.payload.pullId === command.pullId,
        )
      ) {
        return { status: "not_pending", commandId: command.commandId, reason: "resolved" };
      }
      const reserved = state.records.some(
        (record) =>
          record.payload.type === "command" &&
          record.payload.command.type === "respond" &&
          record.payload.command.pullId === command.pullId,
      );
      if (reserved)
        return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
      const closed = state.records.some(
        (record) =>
          record.payload.type === "task_closed" && record.payload.taskId === request.payload.taskId,
      );
      const cancelling = unconsumedCommand(state.records, "cancel_turn");
      if (closed || cancelling?.turnId === request.payload.turnId) {
        return { status: "not_pending", commandId: command.commandId, reason: "cancelled" };
      }
    }

    if (command.type === "cancel_turn") {
      const open = openTurn(state.records);
      if (!open || open.turnId !== command.turnId) {
        return { status: "not_pending", commandId: command.commandId, reason: "unknown" };
      }
      if (unconsumedCommand(state.records, "cancel_turn")?.turnId === command.turnId) {
        return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
      }
    }

    if (command.type === "close_session" && unconsumedCommand(state.records, "close_session")) {
      return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
    }

    const offset = this.#append(state, command.sessionId, { type: "command", command });
    state.commandCanonical.set(command.commandId, canonical);
    state.commandOffsets.set(command.commandId, offset);
    state.coordination.runnable = true;
    if (!state.coordination.ownerId) state.coordination.phase = "runnable";
    return { status: "accepted", commandId: command.commandId, offset };
  }

  *appendExecution(
    lease: Lease,
    expectedHead: number,
    payload: ExecutionJournalPayload,
  ): Operation<AppendExecutionResult> {
    const state = this.#state(lease.sessionId);
    if (!owns(state.coordination, lease, this.#now())) return { status: "fenced" };
    if (state.records.length !== expectedHead) return { status: "head_changed" };
    if (hasSessionClose(state.records)) return { status: "fenced" };
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > this.#maxRecordBytes)
      throw new CrankError("payload_too_large");
    const nextOffset = state.records.length;
    validateJournal([
      ...state.records,
      {
        offset: nextOffset,
        eventId: `journal:${lease.sessionId}:${nextOffset}`,
        sessionId: lease.sessionId,
        ownerEpoch: lease.epoch,
        payload: clone(payload),
      },
    ]);
    const offset = this.#append(state, lease.sessionId, payload, lease.epoch);
    state.coordination.runnable = hasUnconsumedRunnableCommand(state.records);
    return { status: "appended", offset };
  }

  *parkAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult> {
    const state = this.#state(lease.sessionId);
    if (!owns(state.coordination, lease, this.#now())) return "fenced";
    if (state.records.length !== expectedHead || state.coordination.runnable) return "head_changed";
    delete state.coordination.ownerId;
    delete state.coordination.leaseExpiresAt;
    state.coordination.runnable = false;
    state.coordination.phase = hasPendingElicit(state.records) ? "parked" : "idle";
    return "parked";
  }

  *closeAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult> {
    const state = this.#state(lease.sessionId);
    if (!owns(state.coordination, lease, this.#now())) return "fenced";
    if (state.records.length !== expectedHead) return "head_changed";
    delete state.coordination.ownerId;
    delete state.coordination.leaseExpiresAt;
    state.coordination.runnable = false;
    state.coordination.phase = "closed";
    return "closed";
  }

  *runnableSessions(): Operation<string[]> {
    const now = this.#now();
    return [...this.#sessions.values()]
      .filter((state) => {
        if (state.coordination.phase === "closed") return false;
        if (state.coordination.runnable) return true;
        const expiredRunning =
          state.coordination.phase === "running" &&
          state.coordination.leaseExpiresAt !== undefined &&
          Date.parse(state.coordination.leaseExpiresAt) <= now;
        return expiredRunning && hasRecoverableWork(state.records);
      })
      .map((state) => state.coordination.sessionId)
      .sort();
  }

  events(sessionId: string, afterOffset = -1): Stream<JournalRecord, void> {
    const store = this;
    return resource(function* (provide) {
      let cursor = afterOffset;
      yield* provide({
        *next(): Operation<IteratorResult<JournalRecord, void>> {
          while (true) {
            const state = store.#state(sessionId);
            const next = state.records.find((record) => record.offset > cursor);
            if (next) {
              cursor = next.offset;
              return { done: false, value: clone(next) };
            }
            if (state.coordination.phase === "closed") return { done: true, value: undefined };
            yield* action<void>((resolve) => {
              const wake = () => resolve();
              state.waiters.add(wake);
              return () => state.waiters.delete(wake);
            });
          }
        },
      });
    });
  }

  #state(sessionId: string): State {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        records: [],
        coordination: { sessionId, epoch: 0, phase: "idle", journalHead: 0, runnable: false },
        commandOffsets: new Map(),
        commandCanonical: new Map(),
        waiters: new Set(),
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #append(state: State, sessionId: string, payload: JournalPayload, ownerEpoch?: number): number {
    const offset = state.records.length;
    const record: JournalRecord = {
      offset,
      eventId: `journal:${sessionId}:${offset}`,
      sessionId,
      ...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
      payload: clone(payload),
    };
    state.records.push(record);
    state.coordination.journalHead = state.records.length;
    for (const wake of [...state.waiters]) wake();
    state.waiters.clear();
    return offset;
  }
}

export function createInMemoryCrankStore(options?: InMemoryCrankStoreOptions): InMemoryCrankStore {
  return new InMemoryCrankStore(options);
}

function owns(coordination: CoordinationRecord, lease: Lease, now: number): boolean {
  return (
    coordination.ownerId === lease.ownerId &&
    coordination.epoch === lease.epoch &&
    coordination.leaseExpiresAt !== undefined &&
    Date.parse(coordination.leaseExpiresAt) > now
  );
}

function hasSessionClose(records: JournalRecord[]): boolean {
  return records.some((record) => record.payload.type === "session_closed");
}

function openTurn(
  records: JournalRecord[],
): Extract<JournalPayload, { type: "turn_opened" }> | undefined {
  const turns = records.filter(
    (
      record,
    ): record is JournalRecord & { payload: Extract<JournalPayload, { type: "turn_opened" }> } =>
      record.payload.type === "turn_opened",
  );
  return turns
    .map((record) => record.payload)
    .find(
      (turn) =>
        !records.some(
          (record) =>
            record.payload.type === "task_closed" && record.payload.taskId === turn.taskId,
        ),
    );
}

function hasUnconsumedRunnableCommand(records: JournalRecord[]): boolean {
  const consumed = new Set<string>();
  for (const record of records) {
    if (record.payload.type === "turn_opened" || record.payload.type === "session_closed")
      consumed.add(record.payload.commandId);
    if (record.payload.type === "pull_resolved" && record.payload.commandId)
      consumed.add(record.payload.commandId);
    if (record.payload.type === "task_closed" && record.payload.commandId)
      consumed.add(record.payload.commandId);
  }
  return records.some(
    (record) =>
      record.payload.type === "command" && !consumed.has(record.payload.command.commandId),
  );
}

function hasPendingElicit(records: JournalRecord[]): boolean {
  return records.some((record) => {
    if (record.payload.type !== "pull_requested" || record.payload.descriptor.kind !== "elicit")
      return false;
    const pullId = record.payload.pullId;
    const taskId = record.payload.taskId;
    const taskClosed = records.some(
      (candidate) =>
        candidate.payload.type === "task_closed" && candidate.payload.taskId === taskId,
    );
    return (
      !taskClosed &&
      !records.some(
        (candidate) =>
          candidate.payload.type === "pull_resolved" && candidate.payload.pullId === pullId,
      )
    );
  });
}

function hasRecoverableWork(records: JournalRecord[]): boolean {
  if (hasSessionClose(records)) return false;
  return Boolean(openTurn(records) || hasUnconsumedRunnableCommand(records));
}

function unconsumedCommand<K extends SessionCommand["type"]>(
  records: JournalRecord[],
  kind: K,
): Extract<SessionCommand, { type: K }> | undefined {
  const consumed = new Set<string>();
  for (const record of records) {
    if (record.payload.type === "turn_opened" || record.payload.type === "session_closed")
      consumed.add(record.payload.commandId);
    if (record.payload.type === "pull_resolved" && record.payload.commandId)
      consumed.add(record.payload.commandId);
    if (record.payload.type === "task_closed" && record.payload.commandId)
      consumed.add(record.payload.commandId);
  }
  return records
    .filter(
      (
        record,
      ): record is JournalRecord & { payload: Extract<JournalPayload, { type: "command" }> } =>
        record.payload.type === "command",
    )
    .map((record) => record.payload.command)
    .find(
      (command): command is Extract<SessionCommand, { type: K }> =>
        command.type === kind && !consumed.has(command.commandId),
    );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
