import type { Operation } from "effection";
import { assertJson, type JsonObject } from "@sweatpants/foundation";
import {
  MODEL_SAMPLE_EFFECT,
  decodeModelSampleResult,
  encodeModelSampleRequest,
  type ModelSampleRequest,
  type ModelSampleResult,
  type ModelSampleSourceRequest,
} from "./contract.ts";

/** The narrow durable capability required to issue the canonical model.sample effect. */
export interface ModelSampleEffectCaller {
  effect(
    definition: typeof MODEL_SAMPLE_EFFECT,
    input: JsonObject,
    resolver: { readonly audience: string; readonly route?: string },
  ): Operation<JsonObject>;
}

/**
 * Executes the durable model.sample protocol through its owner codecs.
 *
 * Authoring code supplies semantic `ModelSampleRequest` values and receives a
 * semantic `ModelSampleResult`; this helper exclusively owns the durable wire
 * encoding and decoding.
 */
export function* sampleDurableModel(
  caller: ModelSampleEffectCaller,
  request: ModelSampleRequest,
  resolver: { readonly audience: string; readonly route?: string },
): Operation<ModelSampleResult> {
  const wireResult = yield* caller.effect(
    MODEL_SAMPLE_EFFECT,
    encodeModelSampleRequest(request),
    resolver,
  );
  return decodeModelSampleResult(wireResult);
}

/** Executes a bounded source-recipe model pull without embedding provider context. */
export function* sampleDurableModelSource(
  caller: ModelSampleEffectCaller,
  request: ModelSampleSourceRequest,
  resolver: { readonly audience: string; readonly route?: string },
): Operation<ModelSampleResult> {
  const wireResult = yield* caller.effect(
    MODEL_SAMPLE_EFFECT,
    assertJson(request) as JsonObject,
    resolver,
  );
  return decodeModelSampleResult(wireResult);
}
