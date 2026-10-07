import type { ModelSampleRequest } from "@sweatpants/model-sampling";
import { MODEL_SAMPLE_CONTRACT } from "@sweatpants/model-sampling";
import { CrankError } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import {
  ProgramDeliveryApi,
  type ModelSampleDisposition,
  type ModelSampleAttempt,
  type ModelSamplingService,
  type ProgramDeliveryEnvelope,
} from "@sweatpants/model-sampling";
import { stableTupleHash, type Json, canonicalDigest } from "@sweatpants/foundation";

export const AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION = 1 as const;

export interface RemoteSampleIdentity {
  readonly journalId: string;
  readonly journalIncarnation: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
}

export type RemoteSampleState =
  | "starting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export interface RemoteSampleAttachment {
  readonly identity: RemoteSampleIdentity;
  readonly releaseId: string;
  readonly streamId: string;
  readonly producerEpoch: number;
  readonly state: RemoteSampleState;
  readonly terminalLsn?: number;
}

export interface RemoteModelDeliveryEvent {
  readonly version: 1;
  readonly streamId: string;
  readonly lsn: number;
  readonly producerEpoch: number;
  readonly taskId: string;
  readonly pullId: string;
  readonly messageId?: string;
  readonly event: Json;
}

export interface RemoteSampleRecord {
  readonly version: 1;
  readonly identity: RemoteSampleIdentity;
  readonly releaseId: string;
  readonly requestDigest: string;
  readonly effectContractDigest: string;
  readonly classificationsDigest: string;
  readonly streamId: string;
  readonly state: RemoteSampleState;
  readonly producerOwnerId: string;
  readonly producerEpoch: number;
  readonly producerLeaseExpiresAt: string;
  readonly terminalLsn?: number;
  readonly disposition?: ModelSampleDisposition;
  readonly dispositionDigest?: string;
  readonly acknowledgedOutcomeDigest?: string;
  readonly acknowledgedAt?: string;
  readonly retentionExpiresAt: string;
}

export interface RemoteProducerFence {
  readonly ownerId: string;
  readonly producerEpoch: number;
}

export interface PlacementModelSampleProducerStore {
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
}

export interface PlacementModelSampler {
  attach(request: {
    readonly version: 1;
    readonly identity: RemoteSampleIdentity;
    readonly attemptId: string;
    readonly releaseId: string;
    readonly request: ModelSampleRequest;
    readonly requestDigest: string;
    readonly effectContractDigest: string;
    readonly authorization: string;
  }): Operation<RemoteSampleAttachment>;
  read(request: {
    readonly version: 1;
    readonly attachment: RemoteSampleAttachment;
    readonly afterLsn: number;
  }): Operation<{
    readonly events: RemoteModelDeliveryEvent[];
    readonly lsn: number;
    readonly state: RemoteSampleState;
    readonly terminalLsn?: number;
  }>;
  waitForChange(request: {
    readonly version: 1;
    readonly attachment: RemoteSampleAttachment;
    readonly afterLsn: number;
  }): Operation<void>;
  disposition(request: {
    readonly version: 1;
    readonly attachment: RemoteSampleAttachment;
  }): Operation<ModelSampleDisposition | null>;
  cancel(request: {
    readonly version: 1;
    readonly attachment: RemoteSampleAttachment;
    readonly reason?: string;
  }): Operation<void>;
  acknowledge(request: {
    readonly version: 1;
    readonly attachment: RemoteSampleAttachment;
    readonly outcomeDigest: string;
  }): Operation<void>;
}

export interface PlacementSamplingAuthorizationIssuer {
  issue(request: {
    readonly identity: RemoteSampleIdentity;
    readonly attemptId: string;
    readonly releaseId: string;
    readonly requestDigest: string;
    readonly effectContractDigest: string;
    readonly classifications: readonly Json[];
  }): Operation<string>;
}

export interface PlacementModelSamplingService extends ModelSamplingService {
  acknowledge(
    context: Pick<ModelSampleAttempt, "sessionId" | "taskId" | "pullId">,
    outcomeDigest: string,
  ): Operation<void>;
}

function identityFor(context: ModelSampleAttempt): RemoteSampleIdentity {
  return {
    journalId: context.placement.journal.id,
    journalIncarnation: context.placement.journal.incarnation,
    sessionId: context.sessionId,
    taskId: context.taskId,
    pullId: context.pullId,
  };
}

function sampleKey(identity: RemoteSampleIdentity): string {
  return stableTupleHash([
    identity.journalId,
    identity.journalIncarnation,
    identity.sessionId,
    identity.taskId,
    identity.pullId,
  ]);
}

/**
 * Host-side execution-local service. It attaches idempotently, relays only
 * origin LSNs absent from the root log, and leaves semantic resolution to
 * the workflow host's authority path.
 */
export function createPlacementModelSamplingService(options: {
  readonly sampler: PlacementModelSampler;
  readonly authorization: PlacementSamplingAuthorizationIssuer;
  readonly releaseId: (context: ModelSampleAttempt) => string;
  readonly resumeAfter?: (
    identity: RemoteSampleIdentity,
    attachment: RemoteSampleAttachment,
  ) => Operation<number>;
}): PlacementModelSamplingService {
  const attachments = new Map<string, RemoteSampleAttachment>();

  return Object.freeze({
    *sample(request: ModelSampleRequest, context: ModelSampleAttempt) {
      const identity = identityFor(context);
      const releaseId = options.releaseId(context);
      if (!releaseId) {
        throw new CrankError(
          "sampling_placement_unavailable",
          "Execution-local sampling release is unavailable",
        );
      }
      const requestDigest = canonicalDigest(request);
      const contractDigest = effectContractDigest(MODEL_SAMPLE_CONTRACT);
      if (context.effectContractDigest !== contractDigest) {
        throw new CrankError(
          "sampling_placement_unavailable",
          "Execution-local sampling contract differs",
        );
      }
      const authorization = yield* options.authorization.issue({
        identity,
        attemptId: context.attemptId,
        releaseId,
        requestDigest,
        effectContractDigest: contractDigest,
        classifications: request.classifications ?? [],
      });
      const attachment = yield* options.sampler.attach({
        version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
        identity,
        attemptId: context.attemptId,
        releaseId,
        request,
        requestDigest,
        effectContractDigest: contractDigest,
        authorization,
      });
      attachments.set(sampleKey(identity), attachment);
      let afterLsn = options.resumeAfter ? yield* options.resumeAfter(identity, attachment) : 0;

      while (true) {
        if (context.cancellation.aborted) {
          const reason =
            typeof context.cancellation.reason === "string"
              ? context.cancellation.reason
              : undefined;
          yield* options.sampler.cancel({
            version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
            attachment,
            ...(reason ? { reason } : {}),
          });
        }
        const page = yield* options.sampler.read({
          version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
          attachment,
          afterLsn,
        });
        if (page.events.length > 0 && (yield* ProgramDeliveryApi.operations.installed())) {
          const envelopes: ProgramDeliveryEnvelope[] = page.events.map((remote) => ({
            version: 1,
            sessionId: identity.sessionId,
            taskId: identity.taskId,
            pullId: identity.pullId,
            ...(remote.messageId ? { messageId: remote.messageId } : {}),
            origin: {
              kind: "agentcore-model-sample",
              streamId: remote.streamId,
              lsn: remote.lsn,
              producerEpoch: remote.producerEpoch,
            },
            event: remote.event,
          }));
          yield* ProgramDeliveryApi.operations.append(envelopes);
        }
        afterLsn = Math.max(afterLsn, page.lsn);
        if (page.state === "orphaned") {
          throw new CrankError("remote_sample_orphaned", "Remote model producer was orphaned");
        }
        if (["completed", "cancelled", "failed"].includes(page.state)) {
          if (page.terminalLsn === undefined || afterLsn < page.terminalLsn) {
            continue;
          }
          const disposition = yield* options.sampler.disposition({
            version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
            attachment,
          });
          if (!disposition) {
            throw new CrankError(
              "remote_sample_protocol_error",
              "Remote terminal sample has no disposition",
            );
          }
          return disposition;
        }
        yield* options.sampler.waitForChange({
          version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
          attachment,
          afterLsn,
        });
      }
    },

    *acknowledge(
      context: Pick<ModelSampleAttempt, "sessionId" | "taskId" | "pullId">,
      outcomeDigest: string,
    ) {
      const identity: RemoteSampleIdentity = {
        journalId: "",
        journalIncarnation: "",
        sessionId: context.sessionId,
        taskId: context.taskId,
        pullId: context.pullId,
      };
      const attachment = [...attachments.values()].find(
        (candidate) =>
          candidate.identity.sessionId === identity.sessionId &&
          candidate.identity.taskId === identity.taskId &&
          candidate.identity.pullId === identity.pullId,
      );
      if (!attachment) {
        return;
      }
      yield* options.sampler.acknowledge({
        version: AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
        attachment,
        outcomeDigest,
      });
    },
  });
}
