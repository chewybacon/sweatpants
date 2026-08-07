import { CrankError } from "@sweatpants/durable-execution";
import { call, race, sleep, type Operation } from "effection";
import { z } from "zod";
import type { RedisClientType } from "redis";
import type { TokenBuffer, TokenBufferStore } from "@sweatpants/durable-streams";
import { StaleTokenWriterError } from "@sweatpants/durable-streams";
import { type ModelSampleDisposition } from "@sweatpants/model-sampling";
import {
  canonicalJson,
  canonicalSnapshot,
  stableOpaqueId,
  type Json,
} from "@sweatpants/foundation";

import {
  AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
  type PlacementModelSampler,
  type PlacementModelSampleProducerStore,
  type RemoteModelDeliveryEvent,
  type RemoteProducerFence,
  type RemoteSampleAttachment,
  type RemoteSampleIdentity,
  type RemoteSampleRecord,
} from "./placement-model-sampler.ts";

export interface RedisPlacementModelSampler
  extends PlacementModelSampler, PlacementModelSampleProducerStore {
  inspect(identity: RemoteSampleIdentity): Operation<RemoteSampleRecord | null>;
  cleanup(identity: RemoteSampleIdentity): Operation<void>;
}

const CAS_RECORD = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local record = cjson.decode(raw)
local expectedOwner = ARGV[1]
local expectedEpoch = tonumber(ARGV[2])
if record.producerOwnerId ~= expectedOwner or record.producerEpoch ~= expectedEpoch then
  return 'stale'
end
if record.state ~= 'starting' and record.state ~= 'streaming' then return 'closed' end
redis.call('SET', KEYS[1], ARGV[3])
return 'ok'
`;

const CLASSIFY_ORPHAN = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local record = cjson.decode(raw)
if (record.state == 'starting' or record.state == 'streaming') and
   record.producerLeaseExpiresAt <= ARGV[1] then
  record.state = 'orphaned'
  redis.call('SET', KEYS[1], cjson.encode(record))
  return true
end
return false
`;

const ACKNOWLEDGE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local record = cjson.decode(raw)
if not record.dispositionDigest or record.dispositionDigest ~= ARGV[1] then return 'conflict' end
if record.acknowledgedOutcomeDigest and record.acknowledgedOutcomeDigest ~= ARGV[1] then
  return 'conflict'
end
record.acknowledgedOutcomeDigest = ARGV[1]
record.acknowledgedAt = ARGV[2]
record.retentionExpiresAt = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(record))
return 'ok'
`;

function keyFor(prefix: string, identity: RemoteSampleIdentity): string {
  return `${prefix}${canonicalSnapshot(identity as unknown as Json).sha}`;
}
const remoteSampleIdentitySchema = z
  .object({
    journalId: z.string().min(1).max(512),
    journalIncarnation: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
    taskId: z.string().min(1).max(512),
    pullId: z.string().min(1).max(512),
  })
  .strict();
const remoteSampleRecordSchema = z
  .object({
    version: z.literal(1),
    identity: remoteSampleIdentitySchema,
    releaseId: z.string().min(1).max(512),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    effectContractDigest: z.string().regex(/^[0-9a-f]{64}$/),
    classificationsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    streamId: z.string().min(1).max(512),
    state: z.enum(["starting", "streaming", "completed", "cancelled", "failed", "orphaned"]),
    producerOwnerId: z.string().min(1).max(512),
    producerEpoch: z.number().int().nonnegative(),
    producerLeaseExpiresAt: z.string().datetime({ offset: true }),
    terminalLsn: z.number().int().nonnegative().optional(),
    disposition: z.json().optional(),
    dispositionDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    acknowledgedOutcomeDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    acknowledgedAt: z.string().datetime({ offset: true }).optional(),
    retentionExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
function parseRecord(raw: string): RemoteSampleRecord {
  try {
    const value: unknown = JSON.parse(raw);
    return remoteSampleRecordSchema.parse(value) as unknown as RemoteSampleRecord;
  } catch {
    throw new CrankError("remote_sample_protocol_error", "Remote sample record is malformed");
  }
}
function attachment(record: RemoteSampleRecord): RemoteSampleAttachment {
  return {
    identity: record.identity,
    releaseId: record.releaseId,
    streamId: record.streamId,
    producerEpoch: record.producerEpoch,
    state: record.state,
    ...(record.terminalLsn === undefined ? {} : { terminalLsn: record.terminalLsn }),
  };
}
function terminal(state: RemoteSampleRecord["state"]): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/** Redis-backed cross-process control record paired with one fenced TokenBuffer spool. */
export function createRedisPlacementModelSampler(options: {
  readonly client: RedisClientType;
  readonly buffers: TokenBufferStore<RemoteModelDeliveryEvent>;
  readonly releaseId: string;
  readonly authorize: (request: {
    readonly authorization: string;
    readonly identity: RemoteSampleIdentity;
    readonly requestDigest: string;
    readonly effectContractDigest: string;
    readonly releaseId: string;
    readonly classifications: readonly Json[];
  }) => boolean;
  readonly keyPrefix?: string;
  readonly now?: () => number;
  readonly producerLeaseMs?: number;
  readonly unacknowledgedRetentionMs?: number;
  readonly acknowledgedGraceMs?: number;
}): RedisPlacementModelSampler {
  const prefix = options.keyPrefix ?? "sp:model-sample:v1:";
  const now = options.now ?? Date.now;
  const leaseMs = options.producerLeaseMs ?? 60_000;
  const retentionMs = options.unacknowledgedRetentionMs ?? 24 * 60 * 60 * 1_000;
  const graceMs = options.acknowledgedGraceMs ?? 5 * 60 * 1_000;

  function* readRecord(identity: RemoteSampleIdentity): Operation<RemoteSampleRecord | null> {
    const key = keyFor(prefix, identity);
    yield* call(() =>
      options.client.eval(CLASSIFY_ORPHAN, {
        keys: [key],
        arguments: [new Date(now()).toISOString()],
      }),
    );
    const raw = yield* call(() => options.client.get(key));
    return raw ? parseRecord(raw) : null;
  }

  function* requireRecord(identity: RemoteSampleIdentity): Operation<RemoteSampleRecord> {
    const record = yield* readRecord(identity);
    if (!record) {
      throw new CrankError("remote_sample_protocol_error", "Remote sample not found");
    }
    return record;
  }

  function* requireBuffer(streamId: string): Operation<TokenBuffer<RemoteModelDeliveryEvent>> {
    const buffer = yield* options.buffers.get(streamId);
    if (!buffer) {
      throw new CrankError("remote_sample_protocol_error", "Remote sample spool missing");
    }
    return buffer;
  }

  function* cas(
    identity: RemoteSampleIdentity,
    fence: RemoteProducerFence,
    next: RemoteSampleRecord,
  ): Operation<void> {
    const result = yield* call(() =>
      options.client.eval(CAS_RECORD, {
        keys: [keyFor(prefix, identity)],
        arguments: [fence.ownerId, String(fence.producerEpoch), canonicalJson(next)],
      }),
    );
    if (result === "stale") {
      throw new StaleTokenWriterError("Remote producer fence is stale");
    }
    if (result !== "ok") {
      throw new CrankError("remote_sample_conflict", "Remote sample is not producer-mutable");
    }
  }

  return {
    *attach(request) {
      if (request.version !== AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION) {
        throw new CrankError("remote_sample_protocol_error", "Unsupported sampling protocol");
      }
      if (request.releaseId !== options.releaseId) {
        throw new CrankError("sampling_placement_unavailable", "Sampling release is unavailable");
      }
      if (canonicalSnapshot(request.request).sha !== request.requestDigest) {
        throw new CrankError("remote_sample_protocol_error", "Sampling request digest differs");
      }
      const classifications = request.request.classifications ?? [];
      if (
        !options.authorize({
          authorization: request.authorization,
          identity: request.identity,
          requestDigest: request.requestDigest,
          effectContractDigest: request.effectContractDigest,
          releaseId: request.releaseId,
          classifications,
        })
      ) {
        throw new CrankError("remote_sample_unauthorized", "Remote sample authorization failed");
      }
      const key = keyFor(prefix, request.identity);
      const existing = yield* readRecord(request.identity);
      const classificationsDigest = canonicalSnapshot(classifications as Json).sha;
      if (existing) {
        if (
          existing.releaseId !== request.releaseId ||
          existing.requestDigest !== request.requestDigest ||
          existing.effectContractDigest !== request.effectContractDigest ||
          existing.classificationsDigest !== classificationsDigest
        ) {
          throw new CrankError("remote_sample_conflict", "Remote sample identity conflicts");
        }
        return attachment(existing);
      }
      const streamId = stableOpaqueId("remote-sample", [key, request.releaseId]);
      let buffer = yield* options.buffers.get(streamId);
      if (!buffer) {
        try {
          buffer = yield* options.buffers.create(streamId);
        } catch {
          buffer = yield* options.buffers.get(streamId);
        }
      }
      if (!buffer) {
        throw new CrankError("remote_sample_protocol_error", "Cannot create remote spool");
      }
      const record: RemoteSampleRecord = {
        version: 1,
        identity: request.identity,
        releaseId: request.releaseId,
        requestDigest: request.requestDigest,
        effectContractDigest: request.effectContractDigest,
        classificationsDigest,
        streamId,
        state: "starting",
        producerOwnerId: `attempt:${request.attemptId}`,
        producerEpoch: 1,
        producerLeaseExpiresAt: new Date(now() + leaseMs).toISOString(),
        retentionExpiresAt: new Date(now() + retentionMs).toISOString(),
      };
      const result = yield* call(() =>
        options.client.set(key, canonicalJson(record), { NX: true }),
      );
      if (result !== "OK") {
        const winner = yield* requireRecord(request.identity);
        if (
          winner.releaseId !== request.releaseId ||
          winner.requestDigest !== request.requestDigest ||
          winner.effectContractDigest !== request.effectContractDigest ||
          winner.classificationsDigest !== classificationsDigest
        ) {
          throw new CrankError("remote_sample_conflict", "Remote sample identity conflicts");
        }
        return attachment(winner);
      }
      return attachment(record);
    },

    *read({ attachment: requested, afterLsn }) {
      if (!Number.isSafeInteger(afterLsn) || afterLsn < 0) {
        throw new CrankError("remote_sample_protocol_error", "Invalid remote sample cursor");
      }
      const record = yield* requireRecord(requested.identity);
      if (record.streamId !== requested.streamId) {
        throw new CrankError("remote_sample_conflict", "Remote stream identity conflicts");
      }
      const page = yield* (yield* requireBuffer(record.streamId)).read(afterLsn);
      return {
        events: page.tokens,
        lsn: page.lsn,
        state: record.state,
        ...(record.terminalLsn === undefined ? {} : { terminalLsn: record.terminalLsn }),
      };
    },

    *waitForChange({ attachment: requested, afterLsn }) {
      const record = yield* requireRecord(requested.identity);
      if (terminal(record.state) || record.state === "orphaned") {
        return;
      }
      const buffer = yield* requireBuffer(record.streamId);
      const remaining = Math.max(0, Date.parse(record.producerLeaseExpiresAt) - now());
      yield* race([buffer.waitForChange(afterLsn), sleep(remaining)]);
      yield* readRecord(requested.identity);
    },

    *disposition({ attachment: requested }) {
      return (yield* requireRecord(requested.identity)).disposition ?? null;
    },

    *cancel({ attachment: requested }) {
      const record = yield* requireRecord(requested.identity);
      if (terminal(record.state) || record.state === "orphaned") {
        return;
      }
      const disposition: ModelSampleDisposition = { status: "cancelled" };
      const cancelFence = {
        ownerId: `cancel:${requested.identity.pullId}`,
        producerEpoch: record.producerEpoch + 1,
      };
      const next: RemoteSampleRecord = {
        ...record,
        state: "cancelled",
        producerOwnerId: cancelFence.ownerId,
        producerEpoch: cancelFence.producerEpoch,
        terminalLsn: (yield* (yield* requireBuffer(record.streamId)).read(0)).lsn,
        disposition,
        dispositionDigest: canonicalSnapshot(disposition).sha,
      };
      yield* cas(
        requested.identity,
        {
          ownerId: record.producerOwnerId,
          producerEpoch: record.producerEpoch,
        },
        next,
      );
      const writer = yield* (yield* requireBuffer(record.streamId)).claimWriter({
        ownerId: cancelFence.ownerId,
        activationEpoch: cancelFence.producerEpoch,
      });
      yield* writer.complete();
    },

    *acknowledge({ attachment: requested, outcomeDigest }) {
      const at = new Date(now()).toISOString();
      const result = yield* call(() =>
        options.client.eval(ACKNOWLEDGE, {
          keys: [keyFor(prefix, requested.identity)],
          arguments: [outcomeDigest, at, new Date(now() + graceMs).toISOString()],
        }),
      );
      if (result !== "ok") {
        throw new CrankError("remote_sample_conflict", "Acknowledged outcome digest conflicts");
      }
    },

    *claimProducer(identity, request) {
      const record = yield* requireRecord(identity);
      if (
        request.producerEpoch < record.producerEpoch ||
        (request.producerEpoch === record.producerEpoch &&
          request.ownerId !== record.producerOwnerId)
      ) {
        throw new StaleTokenWriterError("Remote producer fence is stale");
      }
      const next = {
        ...record,
        state: "streaming" as const,
        producerOwnerId: request.ownerId,
        producerEpoch: request.producerEpoch,
        producerLeaseExpiresAt: request.leaseExpiresAt,
      };
      yield* cas(
        identity,
        { ownerId: record.producerOwnerId, producerEpoch: record.producerEpoch },
        next,
      );
      yield* (yield* requireBuffer(record.streamId)).claimWriter({
        ownerId: request.ownerId,
        activationEpoch: request.producerEpoch,
      });
      return { ownerId: request.ownerId, producerEpoch: request.producerEpoch };
    },

    *append(identity, fence, events) {
      const record = yield* requireRecord(identity);
      if (
        record.producerOwnerId !== fence.ownerId ||
        record.producerEpoch !== fence.producerEpoch
      ) {
        throw new StaleTokenWriterError("Remote producer fence is stale");
      }
      const buffer = yield* requireBuffer(record.streamId);
      const writer = yield* buffer.claimWriter({
        ownerId: fence.ownerId,
        activationEpoch: fence.producerEpoch,
      });
      const before = (yield* buffer.read(0)).lsn;
      return yield* writer.append(
        events.map((value, index) => ({
          version: 1,
          streamId: record.streamId,
          lsn: before + index + 1,
          producerEpoch: fence.producerEpoch,
          taskId: identity.taskId,
          pullId: identity.pullId,
          ...(value.messageId ? { messageId: value.messageId } : {}),
          event: value.event,
        })),
      );
    },

    *publishDisposition(identity, fence, disposition) {
      const record = yield* requireRecord(identity);
      const buffer = yield* requireBuffer(record.streamId);
      const writer = yield* buffer.claimWriter({
        ownerId: fence.ownerId,
        activationEpoch: fence.producerEpoch,
      });
      const terminalLsn = (yield* buffer.read(0)).lsn;
      const next: RemoteSampleRecord = {
        ...record,
        state:
          disposition.status === "ok"
            ? "completed"
            : disposition.status === "cancelled"
              ? "cancelled"
              : "failed",
        terminalLsn,
        disposition,
        dispositionDigest: canonicalSnapshot(disposition).sha,
      };
      yield* cas(identity, fence, next);
      yield* writer.complete();
    },

    *renewProducer(identity, fence, leaseExpiresAt) {
      const record = yield* requireRecord(identity);
      yield* cas(identity, fence, { ...record, producerLeaseExpiresAt: leaseExpiresAt });
    },

    *inspect(identity) {
      return yield* readRecord(identity);
    },

    *cleanup(identity) {
      const record = yield* readRecord(identity);
      if (!record || Date.parse(record.retentionExpiresAt) > now()) {
        return;
      }
      yield* call(() => options.client.del(keyFor(prefix, identity)));
      yield* options.buffers.delete(record.streamId);
    },
  };
}
