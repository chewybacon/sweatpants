import type { ModelSampleRequest } from "@sweatpants/durable-effects";
import type { Operation } from "effection";
import { type ModelSampleDisposition } from "@sweatpants/session-contract";
import { type Json } from "@sweatpants/foundation";

import type {
  PlacementModelSampleProducerStore,
  RemoteProducerFence,
  RemoteSampleIdentity,
} from "./placement-model-sampler.ts";

export interface PlacementModelProvider {
  sample(
    request: ModelSampleRequest,
    context: {
      readonly signal: AbortSignal;
      emit(event: { readonly event: Json; readonly messageId?: string }): Operation<number>;
    },
  ): Operation<ModelSampleDisposition>;
}

/**
 * The one sanctioned execution-local eager writer. It drains only an already
 * authorized provider request into the fenced remote spool and never receives
 * ProgramPeer or journal-resolution capabilities.
 */
export function* runPlacementModelSampleProducer(request: {
  readonly store: PlacementModelSampleProducerStore;
  readonly provider: PlacementModelProvider;
  readonly identity: RemoteSampleIdentity;
  readonly modelRequest: ModelSampleRequest;
  readonly ownerId: string;
  readonly producerEpoch: number;
  readonly leaseExpiresAt: string;
  readonly cancellation: AbortSignal;
}): Operation<ModelSampleDisposition> {
  const fence: RemoteProducerFence = yield* request.store.claimProducer(request.identity, {
    ownerId: request.ownerId,
    producerEpoch: request.producerEpoch,
    leaseExpiresAt: request.leaseExpiresAt,
  });
  let disposition: ModelSampleDisposition;
  try {
    disposition = yield* request.provider.sample(request.modelRequest, {
      signal: request.cancellation,
      *emit(event) {
        return yield* request.store.append(request.identity, fence, [event]);
      },
    });
  } catch (error) {
    if (request.cancellation.aborted) {
      disposition = { status: "cancelled" };
    } else {
      const message = error instanceof Error ? error.message.slice(0, 512) : "Provider failed";
      disposition = {
        status: "error",
        error: { code: "model_runtime_failed", message },
      };
    }
  }
  yield* request.store.publishDisposition(request.identity, fence, disposition);
  return disposition;
}
