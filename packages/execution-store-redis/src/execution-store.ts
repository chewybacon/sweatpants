import { canonicalSnapshot, sha256, sha256Bytes, type Json } from "@sweatpants/foundation";
import {
  ExecutionStoreError,
  type CommitExecutionRequest,
  type CommitExecutionResult,
  type ExecutionControl,
  type ExecutionObjectPointer,
  type ExecutionStore,
  type PrivateSegmentPointer,
  type StoredExecutionObject,
  type StoredPrivateSegment,
} from "@sweatpants/journal-authority/store";
import { call, type Operation } from "effection";
import type { RedisClientType } from "redis";

export interface RedisExecutionStoreCommandEvidence {
  readonly command: "GET" | "SET_NX" | "EVAL_CAS";
  readonly key: string;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

export interface RedisExecutionStoreOptions {
  readonly keyPrefix?: string;
  readonly onCommand?: (evidence: RedisExecutionStoreCommandEvidence) => void;
}

const CAS_EXECUTION = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
local index = 3
for keyIndex = 2, #KEYS do
  local value = ARGV[index]
  local existing = redis.call('GET', KEYS[keyIndex])
  if existing then
    if existing ~= value then return -1 end
  else
    redis.call('SET', KEYS[keyIndex], value)
  end
  index = index + 1
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

interface EncodedObject {
  readonly objectId: string;
  readonly lifetimeScope: StoredExecutionObject["lifetimeScope"];
  readonly scopeOwnerId: string;
  readonly objectKind: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly bodyKind: "json" | "blob";
  readonly body: Json | string;
}

function invalid(message: string): never {
  throw new ExecutionStoreError("persisted_data_invalid", message);
}

function counter(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return invalid(`${field} is not a decimal counter`);
  }
  return BigInt(value);
}

function validatePrivateSegment(value: unknown, kind: "journal" | "replay"): StoredPrivateSegment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`Redis ${kind} segment is not an object`);
  }
  const segment = value as Record<string, unknown>;
  if (
    typeof segment["segmentId"] !== "string" ||
    typeof segment["executionId"] !== "string" ||
    typeof segment["taskId"] !== "string" ||
    !Array.isArray(segment["entries"]) ||
    typeof segment["contentHash"] !== "string" ||
    typeof segment["encodedBytes"] !== "number" ||
    !Number.isSafeInteger(segment["encodedBytes"]) ||
    segment["encodedBytes"] < 0
  ) {
    return invalid(`Redis ${kind} segment has an invalid shape`);
  }
  const entries = segment["entries"] as Json[];
  const encoded = canonicalSnapshot(entries);
  const first = counter(segment["firstSequence"], "first_sequence");
  const last = counter(segment["lastSequence"], "last_sequence");
  if (
    last < first ||
    last - first + 1n !== BigInt(entries.length) ||
    encoded.sha !== segment["contentHash"] ||
    new TextEncoder().encode(encoded.canonical).byteLength !== segment["encodedBytes"]
  ) {
    return invalid(`Redis ${kind} segment integrity metadata is invalid`);
  }
  if (
    entries.some(
      (entry) =>
        new TextEncoder().encode(canonicalSnapshot(entry).canonical).byteLength > 1024 * 1024,
    )
  ) {
    throw new ExecutionStoreError(
      "segment_entry_too_large",
      `Redis ${kind} segment contains an oversized inline entry`,
    );
  }
  const previous = segment["previous"];
  if (
    previous !== null &&
    (typeof previous !== "object" ||
      Array.isArray(previous) ||
      typeof (previous as Record<string, unknown>)["segmentId"] !== "string" ||
      typeof (previous as Record<string, unknown>)["lastSequence"] !== "string")
  ) {
    return invalid(`Redis ${kind} segment previous pointer is invalid`);
  }
  return segment as unknown as StoredPrivateSegment;
}

function validateControl(value: unknown, executionId: string): ExecutionControl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`Redis execution control record is invalid: ${executionId}`);
  }
  const control = value as Record<string, unknown>;
  if (
    control["executionId"] !== executionId ||
    typeof control["controlRevision"] !== "string" ||
    typeof control["ownerFence"] !== "string" ||
    typeof control["status"] !== "string" ||
    !["active", "parked", "cancelling", "terminal"].includes(control["status"]) ||
    typeof control["rootTaskId"] !== "string" ||
    typeof control["stopGeneration"] !== "string" ||
    (control["requestedDisposition"] !== null &&
      control["requestedDisposition"] !== "cancelled" &&
      control["requestedDisposition"] !== "superseded") ||
    !("control" in control) ||
    typeof control["updatedAt"] !== "number" ||
    !Number.isSafeInteger(control["updatedAt"])
  ) {
    return invalid(`Redis execution control record is invalid: ${executionId}`);
  }
  counter(control["controlRevision"], "control_revision");
  counter(control["ownerFence"], "owner_fence");
  counter(control["stopGeneration"], "stop_generation");
  return value as ExecutionControl;
}

export function createRedisExecutionStore(
  client: RedisClientType,
  options: RedisExecutionStoreOptions = {},
): ExecutionStore {
  const prefix = options.keyPrefix ?? "sweatpants:execution-store:";

  function executionTag(executionId: string): string {
    return `{${encodeURIComponent(executionId)}}`;
  }

  function controlKey(executionId: string): string {
    return `${prefix}execution:${executionTag(executionId)}:control`;
  }

  function segmentKey(kind: "journal" | "replay", executionId: string, segmentId: string): string {
    return `${prefix}execution:${executionTag(executionId)}:${kind}:${sha256(segmentId)}`;
  }

  function objectKey(objectId: string): string {
    return `${prefix}object:{objects}:${sha256(objectId)}`;
  }

  function encode(value: unknown): string {
    return JSON.stringify(value);
  }

  function encodeObject(object: StoredExecutionObject): string {
    const encoded: EncodedObject =
      object.body instanceof Uint8Array
        ? {
            objectId: object.objectId,
            lifetimeScope: object.lifetimeScope,
            scopeOwnerId: object.scopeOwnerId,
            objectKind: object.objectKind,
            contentHash: object.contentHash,
            byteLength: object.byteLength,
            createdAt: object.createdAt,
            bodyKind: "blob",
            body: Buffer.from(object.body).toString("base64"),
          }
        : {
            objectId: object.objectId,
            lifetimeScope: object.lifetimeScope,
            scopeOwnerId: object.scopeOwnerId,
            objectKind: object.objectKind,
            contentHash: object.contentHash,
            byteLength: object.byteLength,
            createdAt: object.createdAt,
            bodyKind: "json",
            body: object.body,
          };
    return encode(encoded);
  }

  function decodeObject(raw: string, objectId: string): StoredExecutionObject {
    let parsed: EncodedObject;
    try {
      parsed = JSON.parse(raw) as EncodedObject;
    } catch {
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `Redis execution object is invalid: ${objectId}`,
      );
    }
    if (
      parsed.objectId !== objectId ||
      (parsed.lifetimeScope !== "execution" && parsed.lifetimeScope !== "conversation") ||
      typeof parsed.scopeOwnerId !== "string" ||
      typeof parsed.objectKind !== "string" ||
      typeof parsed.contentHash !== "string" ||
      typeof parsed.byteLength !== "number" ||
      !Number.isSafeInteger(parsed.byteLength) ||
      parsed.byteLength < 0 ||
      typeof parsed.createdAt !== "number" ||
      !Number.isSafeInteger(parsed.createdAt) ||
      (parsed.bodyKind !== "json" && parsed.bodyKind !== "blob")
    ) {
      return invalid(`Redis execution object is invalid: ${objectId}`);
    }
    let body: Json | Uint8Array;
    let contentHash: string;
    if (parsed.bodyKind === "blob") {
      if (typeof parsed.body !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.body)) {
        return invalid(`Redis execution object is invalid: ${objectId}`);
      }
      body = new Uint8Array(Buffer.from(parsed.body, "base64"));
      contentHash = sha256Bytes(body);
    } else {
      body = parsed.body as Json;
      const encoded = canonicalSnapshot(body);
      contentHash = encoded.sha;
    }
    if (contentHash !== parsed.contentHash) {
      return invalid(`Redis execution object hash is invalid: ${objectId}`);
    }
    const byteLength =
      body instanceof Uint8Array
        ? body.byteLength
        : new TextEncoder().encode(canonicalSnapshot(body).canonical).byteLength;
    if (byteLength !== parsed.byteLength) {
      return invalid(`Redis execution object byte length is invalid: ${objectId}`);
    }
    return {
      objectId: parsed.objectId,
      lifetimeScope: parsed.lifetimeScope,
      scopeOwnerId: parsed.scopeOwnerId,
      objectKind: parsed.objectKind,
      contentHash: parsed.contentHash,
      byteLength: parsed.byteLength,
      createdAt: parsed.createdAt,
      body,
    };
  }

  function decodeControl(raw: string, executionId: string): ExecutionControl {
    let value: ExecutionControl;
    try {
      value = JSON.parse(raw) as ExecutionControl;
    } catch {
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `Redis execution control record is invalid: ${executionId}`,
      );
    }
    return validateControl(value, executionId);
  }

  async function getControl(
    executionId: string,
  ): Promise<{ raw: string; value: ExecutionControl | null }> {
    const key = controlKey(executionId);
    const raw = await client.get(key);
    options.onCommand?.({
      command: "GET",
      key,
      bytesRead: raw === null ? 0 : Buffer.byteLength(raw),
      bytesWritten: 0,
    });
    if (raw === null) return { raw: "", value: null };
    return { raw, value: decodeControl(raw, executionId) };
  }

  async function putImmutable(key: string, value: string): Promise<void> {
    const inserted = await client.setNX(key, value);
    options.onCommand?.({
      command: "SET_NX",
      key,
      bytesRead: 0,
      bytesWritten: Buffer.byteLength(value),
    });
    if (!inserted) {
      const existing = await client.get(key);
      if (existing === null || existing !== value) {
        throw new ExecutionStoreError(
          "immutable_object_conflict",
          `Redis immutable object conflict at ${key}`,
        );
      }
    }
  }

  async function putSegment(
    kind: "journal" | "replay",
    segment: StoredPrivateSegment,
  ): Promise<PrivateSegmentPointer> {
    const validated = validatePrivateSegment(segment, kind);
    const value = encode(validated);
    await putImmutable(segmentKey(kind, segment.executionId, segment.segmentId), value);
    return { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
  }

  async function putObject(object: StoredExecutionObject): Promise<ExecutionObjectPointer> {
    const encoded =
      object.body instanceof Uint8Array
        ? {
            hash: sha256Bytes(object.body),
            bytes: object.body.byteLength,
          }
        : (() => {
            const snapshot = canonicalSnapshot(object.body);
            return {
              hash: snapshot.sha,
              bytes: new TextEncoder().encode(snapshot.canonical).byteLength,
            };
          })();
    if (encoded.hash !== object.contentHash || encoded.bytes !== object.byteLength) {
      return invalid(`Redis execution object integrity metadata is invalid: ${object.objectId}`);
    }
    await putImmutable(objectKey(object.objectId), encodeObject(object));
    return { objectId: object.objectId };
  }

  async function getObject(pointer: ExecutionObjectPointer): Promise<StoredExecutionObject | null> {
    const key = objectKey(pointer.objectId);
    const raw = await client.get(key);
    options.onCommand?.({
      command: "GET",
      key,
      bytesRead: raw === null ? 0 : Buffer.byteLength(raw),
      bytesWritten: 0,
    });
    return raw === null ? null : decodeObject(raw, pointer.objectId);
  }

  async function* readChain(
    kind: "journal" | "replay",
    task: {
      readonly executionId: string;
      readonly taskId: string;
      readonly head: PrivateSegmentPointer | null;
    },
  ): AsyncIterable<readonly Json[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let pointer = task.head;
    while (pointer !== null) {
      if (seen.has(pointer.segmentId)) {
        throw new ExecutionStoreError(
          "persisted_data_invalid",
          `Redis ${kind} chain contains a cycle`,
        );
      }
      seen.add(pointer.segmentId);
      const key = segmentKey(kind, task.executionId, pointer.segmentId);
      const raw = await client.get(key);
      options.onCommand?.({
        command: "GET",
        key,
        bytesRead: raw === null ? 0 : Buffer.byteLength(raw),
        bytesWritten: 0,
      });
      if (raw === null) {
        throw new ExecutionStoreError(
          "persisted_data_invalid",
          `Redis ${kind} segment is missing: ${pointer.segmentId}`,
        );
      }
      let segment: StoredPrivateSegment;
      try {
        segment = validatePrivateSegment(JSON.parse(raw), kind);
      } catch (error) {
        if (error instanceof ExecutionStoreError) {
          throw error;
        }
        return invalid(`Redis ${kind} segment is invalid: ${pointer.segmentId}`);
      }
      if (segment.segmentId !== pointer.segmentId) {
        return invalid(`Redis ${kind} segment identity is invalid: ${pointer.segmentId}`);
      }
      if (segment.executionId !== task.executionId || segment.taskId !== task.taskId) {
        throw new ExecutionStoreError(
          "persisted_data_invalid",
          `Redis ${kind} segment is outside task scope`,
        );
      }
      ids.push(pointer.segmentId);
      pointer = segment.previous;
    }
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const key = segmentKey(kind, task.executionId, ids[index]!);
      const raw = await client.get(key);
      if (raw === null) {
        throw new ExecutionStoreError(
          "persisted_data_invalid",
          `Redis ${kind} segment is missing: ${ids[index]}`,
        );
      }
      let segment: StoredPrivateSegment;
      try {
        segment = validatePrivateSegment(JSON.parse(raw), kind);
      } catch (error) {
        if (error instanceof ExecutionStoreError) {
          throw error;
        }
        return invalid(`Redis ${kind} segment is invalid: ${ids[index]}`);
      }
      if (
        segment.segmentId !== ids[index] ||
        segment.executionId !== task.executionId ||
        segment.taskId !== task.taskId
      ) {
        return invalid(`Redis ${kind} segment is outside task scope: ${ids[index]}`);
      }
      yield [...segment.entries];
    }
  }

  return {
    *loadControl(executionId): Operation<ExecutionControl | null> {
      return (yield* call(() => getControl(executionId))).value;
    },
    *commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult> {
      const loaded = yield* call(() => getControl(request.executionId));
      const current = loaded.value;
      if (current === null) {
        if (request.expectedControlRevision !== null || request.expectedOwnerFence !== "0") {
          return { status: "control_conflict", current: null };
        }
      } else {
        if (current.ownerFence !== request.expectedOwnerFence) {
          return { status: "stale_owner", current };
        }
        if (current.controlRevision !== request.expectedControlRevision) {
          return { status: "control_conflict", current };
        }
      }

      const next: ExecutionControl = {
        ...request.nextControl,
        controlRevision:
          current === null ? "0" : (BigInt(current.controlRevision) + 1n).toString(10),
        updatedAt: request.updatedAt,
      };
      const entries = [
        ...(request.journalSegments ?? []).map(
          (segment) =>
            [
              segmentKey("journal", request.executionId, segment.segmentId),
              encode(segment),
            ] as const,
        ),
        ...(request.replaySegments ?? []).map(
          (segment) =>
            [
              segmentKey("replay", request.executionId, segment.segmentId),
              encode(segment),
            ] as const,
        ),
      ];
      const accepted = yield* call(() =>
        client.eval(CAS_EXECUTION, {
          keys: [controlKey(request.executionId), ...entries.map(([key]) => key)],
          arguments: [loaded.raw, encode(next), ...entries.map(([, value]) => value)],
        }),
      );
      options.onCommand?.({
        command: "EVAL_CAS",
        key: controlKey(request.executionId),
        bytesRead: Buffer.byteLength(loaded.raw),
        bytesWritten:
          Buffer.byteLength(encode(next)) +
          entries.reduce((sum, [, value]) => sum + Buffer.byteLength(value), 0),
      });
      if (Number(accepted) === -1) {
        throw new ExecutionStoreError(
          "immutable_object_conflict",
          `Redis immutable segment conflict for ${request.executionId}`,
        );
      }
      if (Number(accepted) !== 1) {
        const winner = (yield* call(() => getControl(request.executionId))).value;
        return winner && winner.ownerFence !== request.expectedOwnerFence
          ? { status: "stale_owner", current: winner }
          : { status: "control_conflict", current: winner };
      }
      return { status: "committed", control: next };
    },
    *putObject(object): Operation<ExecutionObjectPointer> {
      return yield* call(() => putObject(object));
    },
    *getObject(pointer): Operation<StoredExecutionObject | null> {
      return yield* call(() => getObject(pointer));
    },
    *appendJournalSegment(segment): Operation<PrivateSegmentPointer> {
      return yield* call(() => putSegment("journal", segment));
    },
    *appendReplaySegment(segment): Operation<PrivateSegmentPointer> {
      return yield* call(() => putSegment("replay", segment));
    },
    *readJournal(task): Operation<AsyncIterable<readonly Json[]>> {
      return readChain("journal", task);
    },
    *readReplay(task): Operation<AsyncIterable<readonly Json[]>> {
      return readChain("replay", task);
    },
  };
}
