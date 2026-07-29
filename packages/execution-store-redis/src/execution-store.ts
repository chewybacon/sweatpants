import { createHash } from "node:crypto";

import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { DurableReference, ExecutionId } from "@sweatpants/durable-execution";
import type {
  AppendReplayRequest,
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
  VersionedExecution,
} from "@sweatpants/journal-authority";
import { call, type Operation } from "effection";
import type { RedisClientType } from "redis";

export interface RedisExecutionStoreCommandEvidence {
  readonly command: "GET" | "SET_NX" | "EVAL_CAS";
  readonly key: string;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

export interface RedisExecutionStoreOptions {
  /** Isolates deployments and tests. MUST end in any desired separator. */
  readonly keyPrefix?: string;
  /** Receives evidence at the exact Redis command boundary. */
  readonly onCommand?: (evidence: RedisExecutionStoreCommandEvidence) => void;
}

type StoredPayload =
  | { readonly version: 1; readonly kind: "json"; readonly value: Json }
  | { readonly version: 1; readonly kind: "bytes"; readonly base64: string };

type StoredReplay = {
  readonly version: 1;
  readonly executionId: ExecutionId;
  readonly taskId: string;
  readonly previous: DurableReference | null;
  readonly entries: readonly Json[];
};

const CAS_EXECUTION = `
-- SWEATPANTS_EXECUTION_STORE_V1
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1
`;

/**
 * Redis persistence for the bounded Execution Store.
 *
 * Unlike the legacy Redis authority this driver never reconstructs an
 * in-memory authority and never CAS-replaces a journal-wide snapshot. Control
 * CAS is per execution; payload and replay objects are immutable.
 */
export function createRedisExecutionStore(
  client: RedisClientType,
  options: RedisExecutionStoreOptions = {},
): ExecutionStore {
  const prefix = options.keyPrefix ?? "sweatpants:execution-store:";

  function executionTag(executionId: ExecutionId): string {
    // Braces select one Redis Cluster hash slot for control and private records.
    return `{${encodeURIComponent(executionId)}}`;
  }

  function controlKey(executionId: ExecutionId): string {
    return `${prefix}execution:${executionTag(executionId)}:control`;
  }

  function privateKey(executionId: ExecutionId, revision: number): string {
    return `${prefix}execution:${executionTag(executionId)}:private:${revision}`;
  }

  function objectKey(reference: DurableReference): string {
    return `${prefix}${reference.id}`;
  }

  function integrity(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  function reference(kind: "payload" | "replay", encoded: string): DurableReference {
    const digest = integrity(encoded);
    return {
      id: `${kind}:${digest}`,
      byteLength: Buffer.byteLength(encoded),
      version: "1",
      integrity: { algorithm: "sha256", value: digest },
    };
  }

  async function putImmutable(ref: DurableReference, encoded: string): Promise<void> {
    // Identical content is an idempotent duplicate. A digest collision cannot
    // overwrite an existing object because SET NX is the only write path.
    const key = objectKey(ref);
    await client.setNX(key, encoded);
    options.onCommand?.({
      command: "SET_NX",
      key,
      bytesRead: 0,
      bytesWritten: Buffer.byteLength(encoded),
    });
  }

  async function getImmutable(reference: DurableReference): Promise<string | null> {
    const key = objectKey(reference);
    const encoded = await client.get(key);
    options.onCommand?.({
      command: "GET",
      key,
      bytesRead: encoded === null ? 0 : Buffer.byteLength(encoded),
      bytesWritten: 0,
    });
    if (encoded === null) {
      return null;
    }
    if (
      reference.integrity?.algorithm === "sha256" &&
      integrity(encoded) !== reference.integrity.value
    ) {
      throw new Error(`Redis immutable object failed integrity verification: ${reference.id}`);
    }
    return encoded;
  }

  async function load(executionId: ExecutionId): Promise<{
    readonly raw: string;
    readonly value: VersionedExecution | null;
  }> {
    const key = controlKey(executionId);
    const raw = await client.get(key);
    options.onCommand?.({
      command: "GET",
      key,
      bytesRead: raw === null ? 0 : Buffer.byteLength(raw),
      bytesWritten: 0,
    });
    if (raw === null) {
      return { raw: "", value: null };
    }
    const parsed = JSON.parse(raw) as Partial<VersionedExecution>;
    if (!Number.isInteger(parsed.revision) || parsed.revision! < 0 || parsed.record === undefined) {
      throw new Error(`Redis execution control record is invalid: ${executionId}`);
    }
    return { raw, value: parsed as VersionedExecution };
  }

  return {
    *loadExecution(executionId): Operation<VersionedExecution | null> {
      return (yield* call(() => load(executionId))).value;
    },

    *commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult> {
      const loaded = yield* call(() => load(request.executionId));
      const actualRevision = loaded.value?.revision ?? null;
      if (actualRevision !== request.expectedRevision) {
        return { status: "conflict", actualRevision };
      }

      const revision = (actualRevision ?? -1) + 1;
      const next: VersionedExecution = { revision, record: request.next };
      const control = controlKey(request.executionId);
      const privateRecord = privateKey(request.executionId, revision);
      const encodedNext = JSON.stringify(next);
      const encodedPrivate = JSON.stringify(request.privateRecords);
      const accepted = yield* call(() =>
        client.eval(CAS_EXECUTION, {
          keys: [control, privateRecord],
          arguments: [loaded.raw, encodedNext, encodedPrivate],
        }),
      );
      options.onCommand?.({
        command: "EVAL_CAS",
        key: control,
        bytesRead: Buffer.byteLength(loaded.raw),
        bytesWritten: Buffer.byteLength(encodedNext) + Buffer.byteLength(encodedPrivate),
      });
      if (Number(accepted) === 1) {
        return { status: "accepted", revision };
      }

      // Another writer won after our read. Report its observed revision rather
      // than retrying a transition decision against different state.
      const winner = yield* call(() => load(request.executionId));
      return { status: "conflict", actualRevision: winner.value?.revision ?? null };
    },

    *putPayload(value): Operation<DurableReference> {
      const stored: StoredPayload =
        value instanceof Uint8Array
          ? { version: 1, kind: "bytes", base64: Buffer.from(value).toString("base64") }
          : { version: 1, kind: "json", value };
      const encoded = canonicalSnapshot(stored).canonical;
      const ref = reference("payload", encoded);
      yield* call(() => putImmutable(ref, encoded));
      return ref;
    },

    *getPayload(reference): Operation<Json | Uint8Array | null> {
      const encoded = yield* call(() => getImmutable(reference));
      if (encoded === null) {
        return null;
      }
      const stored = JSON.parse(encoded) as StoredPayload;
      if (stored.version !== 1) {
        throw new Error(`Unsupported Redis payload version: ${reference.id}`);
      }
      return stored.kind === "bytes"
        ? new Uint8Array(Buffer.from(stored.base64, "base64"))
        : stored.value;
    },

    *appendReplay(request: AppendReplayRequest): Operation<DurableReference> {
      const stored: StoredReplay = {
        version: 1,
        executionId: request.executionId,
        taskId: request.taskId,
        previous: request.previous,
        entries: request.entries,
      };
      const encoded = canonicalSnapshot(stored).canonical;
      const ref = reference("replay", encoded);
      yield* call(() => putImmutable(ref, encoded));
      return ref;
    },

    *readReplay(head): Operation<readonly Json[]> {
      if (head === null) {
        return [];
      }
      const chunks: (readonly Json[])[] = [];
      const seen = new Set<string>();
      let cursor: DurableReference | null = head;
      while (cursor) {
        if (seen.has(cursor.id)) {
          throw new Error(`Redis replay chain contains a cycle: ${cursor.id}`);
        }
        seen.add(cursor.id);
        const encoded: string | null = yield* call(() => getImmutable(cursor!));
        if (encoded === null) {
          throw new Error(`Redis replay object is missing: ${cursor.id}`);
        }
        const stored = JSON.parse(encoded) as StoredReplay;
        if (stored.version !== 1 || !Array.isArray(stored.entries)) {
          throw new Error(`Redis replay object is invalid: ${cursor.id}`);
        }
        chunks.push(stored.entries);
        cursor = stored.previous;
      }
      return chunks.reverse().flatMap((entries) => [...entries]);
    },
  };
}
