import { assertJson, canonicalSnapshot, stableTupleHash } from "@sweatpants/foundation";
import { ExecutionStoreApi, installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { withProgramDriverTestPullResolvers } from "@sweatpants/journal-authority/testing";
import type { PullResolver } from "@sweatpants/journal-authority";
import { decodeModelContext, type ModelContext } from "@sweatpants/model-provider";
import {
  decodeModelSampleSourceRequest,
  encodeModelSampleResult,
  ModelContextSourceResolverContext,
  ModelContextSourceStagerContext,
  resolveModelSampleSourceRequest,
  type ModelContextSource,
  type ModelSampleRequest,
  type ModelSampleResult,
} from "@sweatpants/model-sampling";
import type { Operation } from "effection";

const executionStore = createMemoryExecutionStore();

function* stageModelContext(context: ModelContext): Operation<ModelContextSource> {
  const snapshot = canonicalSnapshot(context);
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
  return { type: "object", object, digest: snapshot.sha };
}

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

function sampleResolver(
  sample: (request: ModelSampleRequest) => Operation<ModelSampleResult>,
): PullResolver {
  return {
    kind: "sample",
    audience: () => "model-runtime",
    *perform(_context, descriptor) {
      if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new Error("Sample resolver received a non-object descriptor");
      }
      const record = descriptor;
      if (record["kind"] !== "sample" || record["input"] === undefined) {
        throw new Error("Sample resolver received another pull kind");
      }
      const source = decodeModelSampleSourceRequest(record["input"]);
      const request = resolveModelSampleSourceRequest(
        source,
        yield* resolveModelSampleSource(source.invocation.context),
      );
      return { status: "ok", value: encodeModelSampleResult(yield* sample(request)) };
    },
  };
}

export function* withModelSampleTestBoundary<T>(
  sample: (request: ModelSampleRequest) => Operation<ModelSampleResult>,
  operation: () => Operation<T>,
): Operation<T> {
  yield* installExecutionStore(executionStore);
  return yield* ModelContextSourceStagerContext.with(stageModelContext, function* () {
    return yield* ModelContextSourceResolverContext.with(resolveModelSampleSource, function* () {
      return yield* withProgramDriverTestPullResolvers([sampleResolver(sample)], operation);
    });
  });
}
