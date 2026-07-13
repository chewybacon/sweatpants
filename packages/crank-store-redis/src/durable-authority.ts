import { call, type Operation } from "effection";
import type { RedisClientType } from "redis";
import {
  InMemoryDurableJournalAuthority,
  parseDurableAuthoritySnapshot,
  type AppendEmissionRequest,
  type CapabilityKeyring,
  type CompleteTaskRequest,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type EmissionReceipt,
  type EnsureChildTaskRequest,
  type EnsureChildTaskResult,
  type OpenDurableTaskRequest,
  type ReserveOperationRequest,
  type ReserveOperationResult,
  type ResolveOperationRequest,
  type ResolveOperationResult,
  type TaskCloseReceipt,
} from "@sweatpants/session-contract";

export interface RedisDurableJournalAuthorityOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  keyPrefix?: string;
  now?: () => number;
  maxOutcomeBytes?: number;
}

export interface RedisDurableJournalAuthority {
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }>;
  detachAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    reason?: string,
  ): Operation<void>;
  abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason?: string,
  ): Operation<void>;
  retryIndeterminateEffect(
    sessionId: string,
    taskId: string,
    pullId: string,
    acknowledgeDuplicateRisk: boolean,
  ): Operation<ReserveOperationResult>;
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason: "program_version_unavailable" | "program_corrupt",
  ): Operation<void>;
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  runnableSessions(): Operation<string[]>;
}

const CAS_SNAPSHOT = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export function createRedisDurableJournalAuthority(
  client: RedisClientType,
  options: RedisDurableJournalAuthorityOptions,
): RedisDurableJournalAuthority {
  const key = `${options.keyPrefix ?? "sweatpants:crank:"}durable-authority:${encodeURIComponent(options.journalId)}`;
  const empty: DurableAuthoritySnapshot = {
    version: 1,
    tasks: [],
    records: [],
    runnable: [],
    nonce: 0,
  };

  async function load(): Promise<{ raw: string; snapshot: DurableAuthoritySnapshot }> {
    const raw = await client.get(key);
    return {
      raw: raw ?? "",
      snapshot: raw ? parseDurableAuthoritySnapshot(raw) : empty,
    };
  }

  function authority(snapshot: DurableAuthoritySnapshot): InMemoryDurableJournalAuthority {
    return new InMemoryDurableJournalAuthority({
      journalId: options.journalId,
      keyring: options.keyring,
      snapshot,
      ...(options.journalIncarnation !== undefined
        ? { journalIncarnation: options.journalIncarnation }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.maxOutcomeBytes !== undefined
        ? { maxOutcomeBytes: options.maxOutcomeBytes }
        : {}),
    });
  }

  function* mutate<T>(
    operation: (value: InMemoryDurableJournalAuthority) => Operation<T>,
  ): Operation<T> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const loaded = yield* call(load);
      const value = authority(loaded.snapshot);
      const result = yield* operation(value);
      const encoded = JSON.stringify(value.exportSnapshot());
      const accepted = yield* call(() =>
        client.eval(CAS_SNAPSHOT, {
          keys: [key],
          arguments: [loaded.raw, encoded],
        }),
      );
      if (Number(accepted) === 1) {
        return result;
      }
    }
    throw new Error(`Redis durable authority CAS contention exceeded for ${options.journalId}`);
  }

  function* read<T>(select: (value: InMemoryDurableJournalAuthority) => T): Operation<T> {
    const loaded = yield* call(load);
    return select(authority(loaded.snapshot));
  }

  return {
    *bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch) {
      return yield* mutate((value) =>
        value.bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch),
      );
    },
    *openTask(request) {
      return yield* mutate((value) => value.openTask(request));
    },
    *ensureChildTask(request) {
      return yield* mutate((value) => value.ensureChildTask(request));
    },
    *replaceAttachment(sessionId, taskId, attachmentId, audience) {
      return yield* mutate((value) =>
        value.replaceAttachment(sessionId, taskId, attachmentId, audience),
      );
    },
    *reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
      return yield* mutate((value) => value.reserve(request));
    },
    *resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
      return yield* mutate((value) => value.resolve(request));
    },
    *emit(request: AppendEmissionRequest): Operation<EmissionReceipt> {
      return yield* mutate((value) => value.emit(request));
    },
    *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
      return yield* mutate((value) => value.complete(request));
    },
    *detachAttempt(sessionId, taskId, pullId, reason) {
      yield* mutate((value) => value.detachAttempt(sessionId, taskId, pullId, reason));
    },
    *abandonAttempt(sessionId, taskId, pullId, attemptId, reason) {
      yield* mutate((value) => value.abandonAttempt(sessionId, taskId, pullId, attemptId, reason));
    },
    *retryIndeterminateEffect(sessionId, taskId, pullId, acknowledgeDuplicateRisk) {
      return yield* mutate((value) =>
        value.retryIndeterminateEffect(sessionId, taskId, pullId, acknowledgeDuplicateRisk),
      );
    },
    *forceOrphan(sessionId, taskId, reason) {
      yield* mutate((value) => value.forceOrphan(sessionId, taskId, reason));
    },
    *readJournal(sessionId) {
      return yield* read((value) => value.readJournal(sessionId));
    },
    *runnableSessions() {
      return yield* read((value) => value.runnableSessions());
    },
  };
}
