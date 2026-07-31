import { spawn } from "effection";
import type { Model, StreamOptions } from "@sweatpants/model-provider";
import { createHostModelSamplingService } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  MODEL_SAMPLE_EFFECT,
  type ModelSampleAttempt,
  type ModelSamplingService,
} from "@sweatpants/model-sampling";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import {
  createInMemoryPlacementModelSampler,
  createPlacementModelSamplingService,
  runPlacementModelSampleProducer,
  type PlacementModelProvider,
  type PlacementModelSampler,
  type RemoteSampleIdentity,
} from "@sweatpants/tool-runtime-agentcore";

function identityKey(identity: RemoteSampleIdentity): string {
  return [
    identity.journalId,
    identity.journalIncarnation,
    identity.sessionId,
    identity.taskId,
    identity.pullId,
  ].join("\u0000");
}

/**
 * In-memory AgentCore placement simulator. It deliberately uses the real
 * placement sampler, authorization shape, fenced producer, and disposition
 * relay; only the external AgentCore persistence/transport is in-memory.
 */
export function createSimulatedRemoteModelSamplingService(options: {
  model: Model;
  streamOptions: StreamOptions;
  onEvent?: (
    event: "attached" | "producer_started" | "producer_completed" | "acknowledged",
  ) => void;
}): ModelSamplingService {
  const releaseId = "platform-acceptance-model-release";
  const store = createInMemoryPlacementModelSampler({
    releaseId,
    authorize: ({ authorization }) => authorization === "platform-acceptance-authorized",
  });
  const started = new Set<string>();
  const providerService = createHostModelSamplingService({
    model: options.model,
    streamOptions: options.streamOptions,
    emitLiveEvents: false,
  });
  const providerFor = (
    identity: RemoteSampleIdentity,
    attemptId: string,
  ): PlacementModelProvider => ({
    *sample(request, producerContext) {
      const attempt: ModelSampleAttempt = {
        executor: "execution",
        placement: {
          journal: { id: identity.journalId, incarnation: identity.journalIncarnation },
          program: {
            id: "platform-acceptance.remote-model-producer",
            version: "1",
            digest: "a".repeat(64),
          },
          route: { driverKind: "agentcore" },
          driverKind: "agentcore",
        },
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        pullId: identity.pullId,
        attemptId,
        effectContractDigest: effectContractDigest(MODEL_SAMPLE_EFFECT),
        cancellation: producerContext.signal,
      };
      return yield* providerService.sample(request, attempt);
    },
  });
  const sampler: PlacementModelSampler = {
    ...store,
    *attach(request) {
      const attachment = yield* store.attach(request);
      options.onEvent?.("attached");
      const key = identityKey(request.identity);
      if (!started.has(key)) {
        started.add(key);
        yield* spawn(function* () {
          options.onEvent?.("producer_started");
          try {
            yield* runPlacementModelSampleProducer({
              store,
              provider: providerFor(request.identity, request.attemptId),
              identity: request.identity,
              modelRequest: request.request,
              ownerId: `attempt:${request.attemptId}`,
              producerEpoch: attachment.producerEpoch,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              cancellation: new AbortController().signal,
            });
            options.onEvent?.("producer_completed");
          } catch {
            // The placement protocol retains the terminal failure in its spool.
          }
        });
      }
      return attachment;
    },
    *acknowledge(request) {
      options.onEvent?.("acknowledged");
      yield* store.acknowledge(request);
    },
  };
  return createPlacementModelSamplingService({
    sampler,
    authorization: {
      *issue() {
        return "platform-acceptance-authorized";
      },
    },
    releaseId: () => releaseId,
  });
}
