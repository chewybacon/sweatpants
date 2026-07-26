import { createSignal, race, sleep, spawn, type Operation, type Signal } from "effection";
import { StaleTokenWriterError } from "@sweatpants/durable-streams";
import {
  CrankError,
  canonicalSnapshot,
  stableOpaqueId,
  type Json,
  type ModelSampleDisposition,
} from "@sweatpants/session-contract";

import {
  AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
  type PlacementModelSampler,
  type PlacementModelSampleProducerStore,
  type RemoteModelDeliveryEvent,
  type RemoteSampleAttachment,
  type RemoteSampleIdentity,
  type RemoteSampleRecord,
  type RemoteProducerFence,
} from "./placement-model-sampler.ts";

export interface InMemoryPlacementModelSampler
  extends PlacementModelSampler, PlacementModelSampleProducerStore {
  claimProducer(
    identity: RemoteSampleIdentity,
    request: RemoteProducerFence & { readonly leaseExpiresAt: string },
  ): Operation<RemoteProducerFence>;
  append(
    identity: RemoteSampleIdentity,
    fence: RemoteProducerFence,
    events: readonly { readonly event: Json; readonly messageId?: string }[],
  ): Operation<number>;
  publishDisposition(
    identity: RemoteSampleIdentity,
    fence: RemoteProducerFence,
    disposition: ModelSampleDisposition,
  ): Operation<void>;
  renewProducer(
    identity: RemoteSampleIdentity,
    fence: RemoteProducerFence,
    leaseExpiresAt: string,
  ): Operation<void>;
  inspect(identity: RemoteSampleIdentity): Operation<RemoteSampleRecord | null>;
  cleanup(): Operation<number>;
}

type MutableSample = {
  record: RemoteSampleRecord;
  events: RemoteModelDeliveryEvent[];
  signal: Signal<void, void>;
};

function identityKey(identity: RemoteSampleIdentity): string {
  return [
    identity.journalId,
    identity.journalIncarnation,
    identity.sessionId,
    identity.taskId,
    identity.pullId,
  ].join("\u0000");
}

function attachment(sample: MutableSample): RemoteSampleAttachment {
  const record = sample.record;
  return {
    identity: record.identity,
    releaseId: record.releaseId,
    streamId: record.streamId,
    producerEpoch: record.producerEpoch,
    state: record.state,
    ...(record.terminalLsn === undefined ? {} : { terminalLsn: record.terminalLsn }),
  };
}

function isoMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CrankError("remote_sample_protocol_error", "Invalid remote sample timestamp");
  }
  return parsed;
}

/**
 * Deterministic reference store for the placement protocol. Production Redis
 * adapters must preserve these atomic transition and fencing semantics.
 */
export function createInMemoryPlacementModelSampler(options: {
  readonly releaseId: string;
  readonly authorize: (request: {
    readonly authorization: string;
    readonly identity: RemoteSampleIdentity;
    readonly requestDigest: string;
    readonly effectContractDigest: string;
    readonly releaseId: string;
    readonly classifications: readonly Json[];
  }) => boolean;
  readonly now?: () => number;
  readonly producerLeaseMs?: number;
  readonly unacknowledgedRetentionMs?: number;
  readonly acknowledgedGraceMs?: number;
}): InMemoryPlacementModelSampler {
  const samples = new Map<string, MutableSample>();
  const now = options.now ?? Date.now;
  const leaseMs = options.producerLeaseMs ?? 60_000;
  const retentionMs = options.unacknowledgedRetentionMs ?? 24 * 60 * 60 * 1_000;
  const graceMs = options.acknowledgedGraceMs ?? 5 * 60 * 1_000;

  function get(identity: RemoteSampleIdentity): MutableSample {
    const sample = samples.get(identityKey(identity));
    if (!sample) {
      throw new CrankError("remote_sample_protocol_error", "Remote sample not found");
    }
    classifyOrphan(sample);
    return sample;
  }

  function classifyOrphan(sample: MutableSample): void {
    if (
      (sample.record.state === "starting" || sample.record.state === "streaming") &&
      isoMs(sample.record.producerLeaseExpiresAt) <= now()
    ) {
      sample.record = { ...sample.record, state: "orphaned" };
      sample.signal.send();
    }
  }

  function assertFence(sample: MutableSample, fence: RemoteProducerFence): void {
    if (
      sample.record.producerOwnerId !== fence.ownerId ||
      sample.record.producerEpoch !== fence.producerEpoch
    ) {
      throw new StaleTokenWriterError("Remote sample producer fence is stale");
    }
  }

  function assertMutable(sample: MutableSample): void {
    if (!["starting", "streaming"].includes(sample.record.state)) {
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

      const key = identityKey(request.identity);
      const existing = samples.get(key);
      const classificationsDigest = canonicalSnapshot(classifications as Json).sha;
      if (existing) {
        classifyOrphan(existing);
        if (
          existing.record.releaseId !== request.releaseId ||
          existing.record.requestDigest !== request.requestDigest ||
          existing.record.effectContractDigest !== request.effectContractDigest ||
          existing.record.classificationsDigest !== classificationsDigest
        ) {
          throw new CrankError("remote_sample_conflict", "Remote sample identity conflicts");
        }
        return attachment(existing);
      }

      const streamId = stableOpaqueId("remote-sample", [key, request.releaseId]);
      const created: MutableSample = {
        record: {
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
        },
        events: [],
        signal: createSignal<void, void>(),
      };
      samples.set(key, created);
      return attachment(created);
    },

    *read({ attachment: requested, afterLsn }) {
      if (!Number.isSafeInteger(afterLsn) || afterLsn < 0) {
        throw new CrankError("remote_sample_protocol_error", "Invalid remote sample cursor");
      }
      const sample = get(requested.identity);
      if (sample.record.streamId !== requested.streamId) {
        throw new CrankError("remote_sample_conflict", "Remote stream identity conflicts");
      }
      return {
        events: sample.events.slice(afterLsn),
        lsn: sample.events.length,
        state: sample.record.state,
        ...(sample.record.terminalLsn === undefined
          ? {}
          : { terminalLsn: sample.record.terminalLsn }),
      };
    },

    *waitForChange({ attachment: requested, afterLsn }) {
      const sample = get(requested.identity);
      if (
        sample.events.length > afterLsn ||
        !["starting", "streaming"].includes(sample.record.state)
      ) {
        return;
      }
      const task = yield* spawn(function* () {
        const subscription = yield* sample.signal;
        classifyOrphan(sample);
        if (
          sample.events.length > afterLsn ||
          !["starting", "streaming"].includes(sample.record.state)
        ) {
          return;
        }
        const leaseRemaining = Math.max(0, isoMs(sample.record.producerLeaseExpiresAt) - now());
        yield* race([subscription.next(), sleep(leaseRemaining)]);
        classifyOrphan(sample);
      });
      yield* task;
    },

    *disposition({ attachment: requested }) {
      return get(requested.identity).record.disposition ?? null;
    },

    *cancel({ attachment: requested }) {
      const sample = get(requested.identity);
      if (["completed", "cancelled", "failed", "orphaned"].includes(sample.record.state)) {
        return;
      }
      const disposition: ModelSampleDisposition = { status: "cancelled" };
      sample.record = {
        ...sample.record,
        state: "cancelled",
        terminalLsn: sample.events.length,
        disposition,
        dispositionDigest: canonicalSnapshot(disposition).sha,
      };
      sample.signal.send();
    },

    *acknowledge({ attachment: requested, outcomeDigest }) {
      const sample = get(requested.identity);
      if (!sample.record.dispositionDigest) {
        throw new CrankError("remote_sample_conflict", "Remote sample has no terminal outcome");
      }
      if (sample.record.dispositionDigest !== outcomeDigest) {
        throw new CrankError("remote_sample_conflict", "Acknowledged outcome digest conflicts");
      }
      if (
        sample.record.acknowledgedOutcomeDigest &&
        sample.record.acknowledgedOutcomeDigest !== outcomeDigest
      ) {
        throw new CrankError("remote_sample_conflict", "Acknowledged outcome digest conflicts");
      }
      sample.record = {
        ...sample.record,
        acknowledgedOutcomeDigest: outcomeDigest,
        acknowledgedAt: new Date(now()).toISOString(),
        retentionExpiresAt: new Date(now() + graceMs).toISOString(),
      };
    },

    *claimProducer(identity, request) {
      const sample = get(identity);
      assertMutable(sample);
      if (
        request.producerEpoch < sample.record.producerEpoch ||
        (request.producerEpoch === sample.record.producerEpoch &&
          request.ownerId !== sample.record.producerOwnerId)
      ) {
        throw new StaleTokenWriterError("Remote sample producer fence is stale");
      }
      isoMs(request.leaseExpiresAt);
      sample.record = {
        ...sample.record,
        state: "streaming",
        producerOwnerId: request.ownerId,
        producerEpoch: request.producerEpoch,
        producerLeaseExpiresAt: request.leaseExpiresAt,
      };
      sample.signal.send();
      return { ownerId: request.ownerId, producerEpoch: request.producerEpoch };
    },

    *append(identity, fence, events) {
      const sample = get(identity);
      assertMutable(sample);
      assertFence(sample, fence);
      for (const value of events) {
        const lsn = sample.events.length + 1;
        sample.events.push({
          version: 1,
          streamId: sample.record.streamId,
          lsn,
          producerEpoch: fence.producerEpoch,
          taskId: identity.taskId,
          pullId: identity.pullId,
          ...(value.messageId ? { messageId: value.messageId } : {}),
          event: value.event,
        });
      }
      sample.record = { ...sample.record, state: "streaming" };
      sample.signal.send();
      return sample.events.length;
    },

    *publishDisposition(identity, fence, disposition) {
      const sample = get(identity);
      assertMutable(sample);
      assertFence(sample, fence);
      const state =
        disposition.status === "ok"
          ? "completed"
          : disposition.status === "cancelled"
            ? "cancelled"
            : "failed";
      // One synchronous assignment is the reference atomic terminal commit.
      sample.record = {
        ...sample.record,
        state,
        terminalLsn: sample.events.length,
        disposition,
        dispositionDigest: canonicalSnapshot(disposition).sha,
      };
      sample.signal.send();
    },

    *renewProducer(identity, fence, leaseExpiresAt) {
      const sample = get(identity);
      assertMutable(sample);
      assertFence(sample, fence);
      isoMs(leaseExpiresAt);
      sample.record = { ...sample.record, producerLeaseExpiresAt: leaseExpiresAt };
    },

    *inspect(identity) {
      const sample = samples.get(identityKey(identity));
      if (!sample) {
        return null;
      }
      classifyOrphan(sample);
      return structuredClone(sample.record);
    },

    *cleanup() {
      let deleted = 0;
      for (const [key, sample] of samples) {
        if (isoMs(sample.record.retentionExpiresAt) <= now()) {
          samples.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
