import { call, createSignal, resource, type Operation, type Stream } from "effection";
import type { RedisClientType } from "redis";
export type { CrankStore } from "@sweatpants/session-contract";
import {
  canonicalJson,
  validateJournal,
  validateSessionCommand,
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
} from "@sweatpants/session-contract";

export interface RedisCrankStoreOptions {
  keyPrefix?: string;
  now?: () => number;
  maxCommandBytes?: number;
  maxRecordBytes?: number;
}

type StoredState = {
  records: JournalRecord[];
  coordination: CoordinationRecord;
};

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[4] == '1' then
  redis.call('SADD', KEYS[3], ARGV[3])
else
  redis.call('SREM', KEYS[3], ARGV[3])
end
redis.call('PUBLISH', KEYS[2], '1')
return 1
`;

export function createRedisCrankStore(
  client: RedisClientType,
  options: RedisCrankStoreOptions = {},
): CrankStore {
  const prefix = options.keyPrefix ?? "sweatpants:crank:";
  const now = options.now ?? Date.now;
  const maxCommandBytes = options.maxCommandBytes ?? 1024 * 1024;
  const maxRecordBytes = options.maxRecordBytes ?? 4 * 1024 * 1024;
  const stateKey = (sessionId: string) => `${prefix}${encodeURIComponent(sessionId)}:state`;
  const channel = (sessionId: string) => `${prefix}${encodeURIComponent(sessionId)}:change`;
  const runnableKey = `${prefix}runnable`;

  function initial(sessionId: string): StoredState {
    return {
      records: [],
      coordination: {
        sessionId,
        epoch: 0,
        phase: "idle",
        journalHead: 0,
        runnable: false,
      },
    };
  }

  async function loadRaw(sessionId: string): Promise<{ raw: string; state: StoredState }> {
    const raw = await client.get(stateKey(sessionId));
    return { raw: raw ?? "", state: raw ? (JSON.parse(raw) as StoredState) : initial(sessionId) };
  }

  function* read(sessionId: string): Operation<StoredState> {
    const loaded = yield* call(() => loadRaw(sessionId));
    return structuredClone(loaded.state);
  }

  function* mutate<T>(
    sessionId: string,
    update: (state: StoredState) => { result: T; changed: boolean },
  ): Operation<T> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const loaded = yield* call(() => loadRaw(sessionId));
      const state = structuredClone(loaded.state);
      const { result, changed } = update(state);
      if (!changed) return result;
      const next = JSON.stringify(state);
      const keepRunnable =
        state.coordination.phase !== "closed" &&
        (state.coordination.runnable ||
          (state.coordination.phase === "running" && hasRecoverableWork(state.records)));
      const accepted = yield* call(() =>
        client.eval(CAS_SCRIPT, {
          keys: [stateKey(sessionId), channel(sessionId), runnableKey],
          arguments: [loaded.raw, next, sessionId, keepRunnable ? "1" : "0"],
        }),
      );
      if (Number(accepted) === 1) return result;
    }
    throw new Error(`Redis crank CAS contention exceeded for ${sessionId}`);
  }

  return {
    *ensureSession(sessionId: string) {
      yield* call(() => client.setNX(stateKey(sessionId), JSON.stringify(initial(sessionId))));
    },

    *readJournal(sessionId: string) {
      return (yield* read(sessionId)).records;
    },

    *coordination(sessionId: string) {
      return (yield* read(sessionId)).coordination;
    },

    *claim(sessionId: string, ownerId: string, leaseMs = 30_000): Operation<ClaimResult> {
      return yield* mutate<ClaimResult>(sessionId, (state) => {
        const coordination = state.coordination;
        if (coordination.phase === "closed")
          return { result: { status: "closed" }, changed: false };
        const leaseActive =
          coordination.ownerId !== undefined &&
          coordination.leaseExpiresAt !== undefined &&
          Date.parse(coordination.leaseExpiresAt) > now();
        if (leaseActive) return { result: { status: "busy" }, changed: false };
        coordination.epoch += 1;
        coordination.ownerId = ownerId;
        coordination.leaseExpiresAt = new Date(now() + leaseMs).toISOString();
        coordination.phase = "running";
        coordination.runnable = false;
        return {
          result: {
            sessionId,
            ownerId,
            epoch: coordination.epoch,
            leaseExpiresAt: coordination.leaseExpiresAt,
          },
          changed: true,
        };
      });
    },

    *renewLease(lease: Lease, leaseMs = 30_000) {
      return yield* mutate<Lease | { status: "fenced" }>(lease.sessionId, (state) => {
        if (!owns(state.coordination, lease, now())) {
          return { result: { status: "fenced" as const }, changed: false };
        }
        const leaseExpiresAt = new Date(now() + leaseMs).toISOString();
        state.coordination.leaseExpiresAt = leaseExpiresAt;
        return { result: { ...lease, leaseExpiresAt }, changed: true };
      });
    },

    *appendCommand(command: SessionCommand): Operation<CommandAck> {
      try {
        validateSessionCommand(command);
      } catch {
        return { status: "rejected", commandId: command.commandId, code: "invalid_command" };
      }
      const canonical = canonicalJson(command as never);
      if (Buffer.byteLength(canonical) > maxCommandBytes) {
        return { status: "rejected", commandId: command.commandId, code: "payload_too_large" };
      }
      return yield* mutate(command.sessionId, (state) => {
        const existing = state.records.find(
          (record) =>
            record.payload.type === "command" &&
            record.payload.command.commandId === command.commandId,
        );
        if (existing?.payload.type === "command") {
          return canonicalJson(existing.payload.command as never) === canonical
            ? {
                result: {
                  status: "duplicate" as const,
                  commandId: command.commandId,
                  offset: existing.offset,
                },
                changed: false,
              }
            : {
                result: {
                  status: "rejected" as const,
                  commandId: command.commandId,
                  code: "idempotency_conflict" as const,
                },
                changed: false,
              };
        }
        if (state.coordination.phase === "closed" || hasSessionClose(state.records)) {
          return {
            result: {
              status: "rejected" as const,
              commandId: command.commandId,
              code: "session_closed" as const,
            },
            changed: false,
          };
        }
        if (unconsumedCommand(state.records, "close_session")) {
          return {
            result: {
              status: "rejected" as const,
              commandId: command.commandId,
              code: "session_closed" as const,
            },
            changed: false,
          };
        }
        const rejected = commandRejection(state.records, command);
        if (rejected) return { result: rejected, changed: false };
        const offset = append(state, command.sessionId, { type: "command", command });
        state.coordination.runnable = true;
        if (!state.coordination.ownerId) state.coordination.phase = "runnable";
        return {
          result: { status: "accepted" as const, commandId: command.commandId, offset },
          changed: true,
        };
      });
    },

    *appendExecution(
      lease: Lease,
      expectedHead: number,
      payload: ExecutionJournalPayload,
    ): Operation<AppendExecutionResult> {
      return yield* mutate<AppendExecutionResult>(lease.sessionId, (state) => {
        if (!owns(state.coordination, lease, now())) {
          return { result: { status: "fenced" as const }, changed: false };
        }
        if (state.records.length !== expectedHead) {
          return { result: { status: "head_changed" as const }, changed: false };
        }
        if (hasSessionClose(state.records)) {
          return { result: { status: "fenced" as const }, changed: false };
        }
        if (Buffer.byteLength(JSON.stringify(payload)) > maxRecordBytes) {
          throw new Error("payload_too_large");
        }
        const offset = state.records.length;
        const candidate: JournalRecord = {
          offset,
          eventId: `journal:${lease.sessionId}:${offset}`,
          sessionId: lease.sessionId,
          ownerEpoch: lease.epoch,
          payload: structuredClone(payload),
        };
        validateJournal([...state.records, candidate]);
        state.records.push(candidate);
        state.coordination.journalHead = state.records.length;
        state.coordination.runnable = hasUnconsumedRunnableCommand(state.records);
        return { result: { status: "appended" as const, offset }, changed: true };
      });
    },

    *parkAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult> {
      return yield* mutate(lease.sessionId, (state) => {
        if (!owns(state.coordination, lease, now()))
          return { result: "fenced" as const, changed: false };
        if (state.records.length !== expectedHead || state.coordination.runnable) {
          return { result: "head_changed" as const, changed: false };
        }
        delete state.coordination.ownerId;
        delete state.coordination.leaseExpiresAt;
        state.coordination.runnable = false;
        state.coordination.phase = hasPendingElicit(state.records) ? "parked" : "idle";
        return { result: "parked" as const, changed: true };
      });
    },

    *closeAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult> {
      return yield* mutate(lease.sessionId, (state) => {
        if (!owns(state.coordination, lease, now()))
          return { result: "fenced" as const, changed: false };
        if (state.records.length !== expectedHead)
          return { result: "head_changed" as const, changed: false };
        delete state.coordination.ownerId;
        delete state.coordination.leaseExpiresAt;
        state.coordination.runnable = false;
        state.coordination.phase = "closed";
        return { result: "closed" as const, changed: true };
      });
    },

    *runnableSessions() {
      const queued = yield* call(() => client.sMembers(runnableKey));
      const sessions: string[] = [];
      for (const sessionId of queued) {
        const state = yield* read(sessionId);
        const expiredRunning =
          state.coordination.phase === "running" &&
          state.coordination.leaseExpiresAt !== undefined &&
          Date.parse(state.coordination.leaseExpiresAt) <= now();
        if (
          state.coordination.phase !== "closed" &&
          (state.coordination.runnable || (expiredRunning && hasRecoverableWork(state.records)))
        ) {
          sessions.push(sessionId);
        }
      }
      return sessions.sort();
    },

    events(sessionId: string, afterOffset = -1): Stream<JournalRecord, void> {
      return resource(function* (provide) {
        const subscriber = client.duplicate() as RedisClientType;
        const signal = createSignal<void, void>();
        yield* call(async () => {
          await subscriber.connect();
          await subscriber.subscribe(channel(sessionId), () => signal.send());
        });
        let cursor = afterOffset;
        try {
          yield* provide({
            *next(): Operation<IteratorResult<JournalRecord, void>> {
              while (true) {
                const subscription = yield* signal;
                const state = yield* read(sessionId);
                const next = state.records.find((record) => record.offset > cursor);
                if (next) {
                  cursor = next.offset;
                  return { done: false, value: structuredClone(next) };
                }
                if (state.coordination.phase === "closed") return { done: true, value: undefined };
                yield* subscription.next();
              }
            },
          });
        } finally {
          yield* call(async () => {
            await subscriber.unsubscribe(channel(sessionId));
            await subscriber.quit();
          });
        }
      });
    },
  };
}

function append(
  state: StoredState,
  sessionId: string,
  payload: JournalPayload,
  ownerEpoch?: number,
): number {
  const offset = state.records.length;
  state.records.push({
    offset,
    eventId: `journal:${sessionId}:${offset}`,
    sessionId,
    ...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
    payload: structuredClone(payload),
  });
  state.coordination.journalHead = state.records.length;
  return offset;
}

function owns(coordination: CoordinationRecord, lease: Lease, at: number): boolean {
  return (
    coordination.ownerId === lease.ownerId &&
    coordination.epoch === lease.epoch &&
    coordination.leaseExpiresAt !== undefined &&
    Date.parse(coordination.leaseExpiresAt) > at
  );
}

function commandRejection(
  records: JournalRecord[],
  command: SessionCommand,
): CommandAck | undefined {
  if (command.type === "respond") {
    const request = records.find(
      (record) =>
        record.payload.type === "pull_requested" && record.payload.pullId === command.pullId,
    );
    if (!request || request.payload.type !== "pull_requested") {
      return { status: "not_pending", commandId: command.commandId, reason: "unknown" };
    }
    if (request.payload.descriptor.kind !== "elicit") {
      return { status: "not_pending", commandId: command.commandId, reason: "wrong_kind" };
    }
    if (
      records.some(
        (record) =>
          record.payload.type === "pull_resolved" && record.payload.pullId === command.pullId,
      )
    ) {
      return { status: "not_pending", commandId: command.commandId, reason: "resolved" };
    }
    if (
      records.some(
        (record) =>
          record.payload.type === "command" &&
          record.payload.command.type === "respond" &&
          record.payload.command.pullId === command.pullId,
      )
    ) {
      return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
    }
    const requestTaskId = request.payload.taskId;
    const requestTurnId = request.payload.turnId;
    if (
      records.some(
        (record) =>
          record.payload.type === "task_closed" && record.payload.taskId === requestTaskId,
      ) ||
      unconsumedCommand(records, "cancel_turn")?.turnId === requestTurnId
    ) {
      return { status: "not_pending", commandId: command.commandId, reason: "cancelled" };
    }
  }
  if (command.type === "cancel_turn") {
    const open = openTurn(records);
    if (!open || open.turnId !== command.turnId) {
      return { status: "not_pending", commandId: command.commandId, reason: "unknown" };
    }
    if (unconsumedCommand(records, "cancel_turn")?.turnId === command.turnId) {
      return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
    }
  }
  if (command.type === "close_session" && unconsumedCommand(records, "close_session")) {
    return { status: "not_pending", commandId: command.commandId, reason: "reserved" };
  }
  return undefined;
}

function openTurn(records: JournalRecord[]) {
  return records
    .filter((record) => record.payload.type === "turn_opened")
    .map((record) => record.payload as Extract<JournalPayload, { type: "turn_opened" }>)
    .find(
      (turn) =>
        !records.some(
          (record) =>
            record.payload.type === "task_closed" && record.payload.taskId === turn.taskId,
        ),
    );
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
    .filter((record) => record.payload.type === "command")
    .map((record) => (record.payload as Extract<JournalPayload, { type: "command" }>).command)
    .find(
      (candidate): candidate is Extract<SessionCommand, { type: K }> =>
        candidate.type === kind && !consumed.has(candidate.commandId),
    );
}

function hasUnconsumedRunnableCommand(records: JournalRecord[]): boolean {
  return records.some(
    (record) =>
      record.payload.type === "command" && !isConsumed(records, record.payload.command.commandId),
  );
}

function isConsumed(records: JournalRecord[], commandId: string): boolean {
  return records.some((record) =>
    record.payload.type === "turn_opened" || record.payload.type === "session_closed"
      ? record.payload.commandId === commandId
      : (record.payload.type === "pull_resolved" || record.payload.type === "task_closed") &&
        record.payload.commandId === commandId,
  );
}

function hasSessionClose(records: JournalRecord[]): boolean {
  return records.some((record) => record.payload.type === "session_closed");
}

function hasPendingElicit(records: JournalRecord[]): boolean {
  return records.some((record) => {
    if (record.payload.type !== "pull_requested" || record.payload.descriptor.kind !== "elicit")
      return false;
    const taskId = record.payload.taskId;
    const pullId = record.payload.pullId;
    return (
      !records.some(
        (candidate) =>
          candidate.payload.type === "task_closed" && candidate.payload.taskId === taskId,
      ) &&
      !records.some(
        (candidate) =>
          candidate.payload.type === "pull_resolved" && candidate.payload.pullId === pullId,
      )
    );
  });
}

function hasRecoverableWork(records: JournalRecord[]): boolean {
  return (
    !hasSessionClose(records) && Boolean(openTurn(records) || hasUnconsumedRunnableCommand(records))
  );
}
