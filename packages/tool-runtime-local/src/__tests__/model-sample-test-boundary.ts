import { canonicalSnapshot, stableTupleHash, assertJson, type Json } from "@sweatpants/foundation";
import {
  DurableEffectInputPreparationContext,
  type DurableEffectInputPreparation,
  type DurableEffectInputPreparer,
} from "@sweatpants/durable-execution";
import { ExecutionStoreApi, installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { decodeModelContext, type ModelContext } from "@sweatpants/model-provider";
import {
  decodeModelSampleRequest,
  encodeModelSampleSourceRequest,
  ModelContextSourceResolverContext,
  type ModelContextSource,
  type ModelSampleSourceRequest,
} from "@sweatpants/model-sampling";
import { MODEL_SAMPLE_EFFECT } from "@sweatpants/model-sampling";
import type { Operation } from "effection";

const executionStore = createMemoryExecutionStore();

const prepareModelSample: DurableEffectInputPreparer = function* (
  request: DurableEffectInputPreparation,
): Operation<Json> {
  if (
    request.name !== MODEL_SAMPLE_EFFECT.name ||
    request.version !== MODEL_SAMPLE_EFFECT.version
  ) {
    return request.input;
  }
  const decoded = decodeModelSampleRequest(request.input);
  const snapshot = canonicalSnapshot(decoded.invocation.context);
  const object = yield* ExecutionStoreApi.operations.putObject({
    objectId: stableTupleHash(["tool-runtime-local-model-context", snapshot.sha]),
    lifetimeScope: "conversation",
    scopeOwnerId: "tool-runtime-local-tests",
    objectKind: "model-context-source.v1",
    contentHash: snapshot.sha,
    byteLength: new TextEncoder().encode(snapshot.canonical).byteLength,
    body: assertJson(snapshot.value),
    createdAt: Date.now(),
  });
  const source: ModelSampleSourceRequest = {
    ...decoded,
    invocation: {
      ...(decoded.invocation.options === undefined ? {} : { options: decoded.invocation.options }),
      context: { type: "object", object, digest: snapshot.sha },
    },
  };
  return encodeModelSampleSourceRequest(source);
};

function* resolveModelSampleSource(source: ModelContextSource): Operation<ModelContext> {
  if (source.type !== "object") {
    throw new Error("Tool-runtime-local model sample test source must be an object");
  }
  const stored = yield* ExecutionStoreApi.operations.getObject(source.object);
  if (
    !stored ||
    stored.objectKind !== "model-context-source.v1" ||
    stored.contentHash !== source.digest
  ) {
    throw new Error("Tool-runtime-local model sample source is missing or corrupt");
  }
  return decodeModelContext(stored.body);
}

export function* withModelSampleTestBoundary<T>(operation: () => Operation<T>): Operation<T> {
  yield* installExecutionStore(executionStore);
  return yield* DurableEffectInputPreparationContext.with(prepareModelSample, function* () {
    return yield* ModelContextSourceResolverContext.with(resolveModelSampleSource, operation);
  });
}
