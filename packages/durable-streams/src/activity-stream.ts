import type { Operation } from "effection";

export type ActivityStreamId = string;
export type ActivityCursor = number;

export type ActivityWriterIdentity =
  | { kind: "task-attempt"; taskId: string; attemptId: string }
  | { kind: "activation"; taskId: string; activationId: string };

export interface ActivityWriterFence {
  streamId: ActivityStreamId;
  writer: ActivityWriterIdentity;
  epoch: number;
}

export type ActivityRetentionPolicy =
  | { mode: "auto_delete_on_close" }
  | { mode: "retain_forever" }
  | { mode: "retain_until_ttl"; ttlMs: number };

export interface ActivityPayloadCodec<T> {
  digest(value: T): string;
  byteLength(value: T): number;
}

export interface ActivityChunk<T> {
  cursor: ActivityCursor;
  payload: T;
  payloadDigest: string;
}

export type ActivityClose =
  | { status: "complete"; summaryDigest?: string }
  | { status: "aborted"; summaryDigest?: string }
  | { status: "error"; errorCode: string; summaryDigest?: string };

export interface ActivityReadResult<T> {
  chunks: readonly ActivityChunk<T>[];
  headCursor: ActivityCursor;
  close?: ActivityClose;
}

export interface ActivityStreamStore<T> {
  create(request: {
    streamId: ActivityStreamId;
    retention: ActivityRetentionPolicy;
  }): Operation<void>;
  claimWriter(request: {
    streamId: ActivityStreamId;
    writer: ActivityWriterIdentity;
  }): Operation<ActivityWriterFence>;
  append(request: {
    fence: ActivityWriterFence;
    cursor: ActivityCursor;
    payload: T;
  }): Operation<{ cursor: ActivityCursor; duplicate: boolean }>;
  read(request: {
    streamId: ActivityStreamId;
    afterCursor?: ActivityCursor;
  }): Operation<ActivityReadResult<T>>;
  close(request: {
    fence: ActivityWriterFence;
    close: ActivityClose;
  }): Operation<{ duplicate: boolean }>;
  delete(streamId: ActivityStreamId): Operation<void>;
}

export type ActivityStreamErrorCode =
  | "activity_stream_not_found"
  | "activity_stream_conflict"
  | "activity_stream_fenced"
  | "activity_stream_cursor_gap"
  | "activity_stream_closed";

export class ActivityStreamError extends Error {
  override readonly name = "ActivityStreamError";

  constructor(
    readonly code: ActivityStreamErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

interface StreamState<T> {
  readonly streamId: string;
  readonly retention: ActivityRetentionPolicy;
  readonly chunks: ActivityChunk<T>[];
  writer?: ActivityWriterIdentity;
  fenceEpoch: number;
  close?: ActivityClose;
  closedAt?: number;
}

export interface InMemoryActivityStreamOptions<T> {
  codec: ActivityPayloadCodec<T>;
  now?: () => number;
}

export function createInMemoryActivityStreamStore<T>(
  options: InMemoryActivityStreamOptions<T>,
): ActivityStreamStore<T> {
  const streams = new Map<string, StreamState<T>>();
  const now = options.now ?? Date.now;

  function state(streamId: string): StreamState<T> {
    const selected = streams.get(streamId);
    if (!selected) throw new ActivityStreamError("activity_stream_not_found");
    if (
      selected.close &&
      selected.retention.mode === "retain_until_ttl" &&
      now() >= (selected.closedAt ?? 0) + selected.retention.ttlMs
    ) {
      streams.delete(streamId);
      throw new ActivityStreamError("activity_stream_not_found");
    }
    return selected;
  }

  function assertFence(selected: StreamState<T>, fence: ActivityWriterFence): void {
    if (
      fence.streamId !== selected.streamId ||
      fence.epoch !== selected.fenceEpoch ||
      !selected.writer ||
      writerKey(fence.writer) !== writerKey(selected.writer)
    ) {
      throw new ActivityStreamError("activity_stream_fenced");
    }
  }

  return {
    *create(request): Operation<void> {
      validateStreamId(request.streamId);
      validateRetention(request.retention);
      let existing: StreamState<T> | undefined;
      try {
        existing = state(request.streamId);
      } catch (error) {
        if (!(error instanceof ActivityStreamError) || error.code !== "activity_stream_not_found") {
          throw error;
        }
      }
      if (existing) {
        if (retentionKey(existing.retention) !== retentionKey(request.retention)) {
          throw new ActivityStreamError("activity_stream_conflict");
        }
        return;
      }
      streams.set(request.streamId, {
        streamId: request.streamId,
        retention: structuredClone(request.retention),
        chunks: [],
        fenceEpoch: 0,
      });
    },

    *claimWriter(request): Operation<ActivityWriterFence> {
      const selected = state(request.streamId);
      if (selected.close) throw new ActivityStreamError("activity_stream_closed");
      validateWriter(request.writer);
      selected.fenceEpoch += 1;
      selected.writer = structuredClone(request.writer);
      return {
        streamId: selected.streamId,
        writer: structuredClone(request.writer),
        epoch: selected.fenceEpoch,
      };
    },

    *append(request): Operation<{ cursor: ActivityCursor; duplicate: boolean }> {
      const selected = state(request.fence.streamId);
      assertFence(selected, request.fence);
      validateAppendCursor(request.cursor);
      if (selected.close) throw new ActivityStreamError("activity_stream_closed");
      const payloadDigest = options.codec.digest(request.payload);
      const byteLength = options.codec.byteLength(request.payload);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !payloadDigest) {
        throw new ActivityStreamError("activity_stream_conflict", "Invalid payload codec result");
      }
      const existing = selected.chunks[request.cursor - 1];
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) {
          throw new ActivityStreamError("activity_stream_conflict");
        }
        return { cursor: request.cursor, duplicate: true };
      }
      if (request.cursor !== selected.chunks.length + 1) {
        throw new ActivityStreamError("activity_stream_cursor_gap");
      }
      selected.chunks.push({
        cursor: request.cursor,
        payload: structuredClone(request.payload),
        payloadDigest,
      });
      return { cursor: request.cursor, duplicate: false };
    },

    *read(request): Operation<ActivityReadResult<T>> {
      const selected = state(request.streamId);
      const afterCursor = request.afterCursor ?? 0;
      if (
        !Number.isSafeInteger(afterCursor) ||
        afterCursor < 0 ||
        afterCursor > selected.chunks.length
      ) {
        throw new ActivityStreamError("activity_stream_cursor_gap");
      }
      return {
        chunks: structuredClone(selected.chunks.slice(afterCursor)),
        headCursor: selected.chunks.length,
        ...(selected.close ? { close: structuredClone(selected.close) } : {}),
      };
    },

    *close(request): Operation<{ duplicate: boolean }> {
      const selected = state(request.fence.streamId);
      assertFence(selected, request.fence);
      validateClose(request.close);
      if (selected.close) {
        if (closeKey(selected.close) !== closeKey(request.close)) {
          throw new ActivityStreamError("activity_stream_conflict");
        }
        return { duplicate: true };
      }
      selected.close = structuredClone(request.close);
      selected.closedAt = now();
      if (selected.retention.mode === "auto_delete_on_close") {
        streams.delete(selected.streamId);
      }
      return { duplicate: false };
    },

    *delete(streamId): Operation<void> {
      validateStreamId(streamId);
      streams.delete(streamId);
    },
  };
}

function validateStreamId(streamId: string): void {
  if (!streamId) throw new ActivityStreamError("activity_stream_conflict", "streamId is required");
}

function validateRetention(retention: ActivityRetentionPolicy): void {
  if (
    retention.mode === "retain_until_ttl" &&
    (!Number.isSafeInteger(retention.ttlMs) || retention.ttlMs <= 0)
  ) {
    throw new ActivityStreamError("activity_stream_conflict", "ttlMs must be positive");
  }
}

function validateWriter(writer: ActivityWriterIdentity): void {
  if (!writer.taskId) throw new ActivityStreamError("activity_stream_conflict");
  if (writer.kind === "task-attempt" ? !writer.attemptId : !writer.activationId) {
    throw new ActivityStreamError("activity_stream_conflict");
  }
}

function validateAppendCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new ActivityStreamError("activity_stream_cursor_gap");
  }
}

function validateClose(close: ActivityClose): void {
  if (close.status === "error" && !close.errorCode) {
    throw new ActivityStreamError("activity_stream_conflict");
  }
}

function writerKey(writer: ActivityWriterIdentity): string {
  return writer.kind === "task-attempt"
    ? `${writer.kind}\u0000${writer.taskId}\u0000${writer.attemptId}`
    : `${writer.kind}\u0000${writer.taskId}\u0000${writer.activationId}`;
}

function retentionKey(retention: ActivityRetentionPolicy): string {
  return retention.mode === "retain_until_ttl"
    ? `${retention.mode}:${retention.ttlMs}`
    : retention.mode;
}

function closeKey(close: ActivityClose): string {
  return `${close.status}\u0000${close.status === "error" ? close.errorCode : ""}\u0000${close.summaryDigest ?? ""}`;
}
