import {
  decodeModelSampleRequest,
  decodeModelSampleResult,
  MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
  encodeModelSampleSourceRequest,
  ModelContextSourceStagerContext,
  type ModelSampleRequest,
  type ModelSampleResult,
} from "@sweatpants/model-sampling";
import type { Operation } from "effection";

import {
  createPinnedDurableProgram,
  defineDurableProgramManifest,
} from "@sweatpants/durable-execution";
import {
  EPHEMERAL_INPUT_CONTEXT_DESCRIPTOR,
  EPHEMERAL_INPUT_RESPONSE_DESCRIPTOR,
  EPHEMERAL_TOOL_ADAPTER_INPUT_DESCRIPTOR,
  EPHEMERAL_TOOL_ADAPTER_OUTPUT_DESCRIPTOR,
  EPHEMERAL_TOOL_ADAPTER_PROGRAM,
  EPHEMERAL_TOOL_CONTINUE_EFFECT,
  EPHEMERAL_TOOL_START_EFFECT,
} from "./ephemeral-contract.ts";
import { projectModelSampleCompletion } from "@sweatpants/agent-sdk";
import {
  CrankError,
  DurableProgramCancellation,
  type DurableProgramContext,
} from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { EphemeralToolRequest } from "@sweatpants/durable-execution";

/**
 * Classification stamped onto every model.sample raised on behalf of a
 * ephemeral tool's nested ctx.sample(). Hosts use it to keep tool-owned
 * sampling out of outer-chat streaming and history.
 */
export const TOOL_OWNED_SAMPLE_CLASSIFICATION = "sweatpants.tool-owned-sample";

function classifyToolOwnedSample(payload: Json): ModelSampleRequest {
  const request = decodeModelSampleRequest(payload);
  const existing = request.classifications ?? [];
  if (existing.includes(TOOL_OWNED_SAMPLE_CLASSIFICATION)) return request;
  return { ...request, classifications: [...existing, TOOL_OWNED_SAMPLE_CLASSIFICATION] };
}

function* sampleToolOwnedModel(
  context: DurableProgramContext,
  payload: Json,
): Operation<ModelSampleResult> {
  const request = classifyToolOwnedSample(payload);
  const stage = yield* ModelContextSourceStagerContext.get();
  if (!stage) {
    throw new CrankError(
      "model_context_source_invalid",
      "Ephemeral adapter model sampling requires an authoring-edge context stager",
    );
  }
  const source = yield* stage(request.invocation.context);
  const wireRequest = encodeModelSampleSourceRequest({
    ...request,
    invocation: {
      context: source,
      ...(request.invocation.options === undefined ? {} : { options: request.invocation.options }),
    },
  });
  return decodeModelSampleResult(
    yield* context.pull(assertJson({ kind: "sample", input: wireRequest })),
  );
}

/** Validated manifest for the built-in ephemeral adapter child program. */
export const EPHEMERAL_TOOL_ADAPTER_MANIFEST = defineDurableProgramManifest<
  EphemeralToolRequest,
  Json
>({
  programId: EPHEMERAL_TOOL_ADAPTER_PROGRAM.id,
  version: EPHEMERAL_TOOL_ADAPTER_PROGRAM.version,
  digest: EPHEMERAL_TOOL_ADAPTER_PROGRAM.digest,
  inputSchema: EPHEMERAL_TOOL_ADAPTER_INPUT_DESCRIPTOR,
  outputSchema: EPHEMERAL_TOOL_ADAPTER_OUTPUT_DESCRIPTOR,
  elicits: {
    ephemeral_input: {
      response: EPHEMERAL_INPUT_RESPONSE_DESCRIPTOR,
      context: EPHEMERAL_INPUT_CONTEXT_DESCRIPTOR,
    },
  },
  effects: {
    [EPHEMERAL_TOOL_START_EFFECT.name]: EPHEMERAL_TOOL_START_EFFECT,
    [EPHEMERAL_TOOL_CONTINUE_EFFECT.name]: EPHEMERAL_TOOL_CONTINUE_EFFECT,
  },
  pulls: {
    sample: {
      input: MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
      output: MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
    },
  },
  capabilities: {
    durableEmissions: false,
    structuredChildren: false,
    replay: "strict",
  },
});

const adapterTool = createPinnedDurableProgram(
  EPHEMERAL_TOOL_ADAPTER_MANIFEST,
  function* (request, context) {
    const audience = `ephemeral:${request.driver}`;
    let disposition = yield* context.effect(EPHEMERAL_TOOL_START_EFFECT, request, {
      audience,
      ...(request.route ? { route: request.route } : {}),
    });

    try {
      while (disposition.type === "input_required") {
        const response =
          disposition.request.kind === "sample"
            ? projectModelSampleCompletion(
                yield* sampleToolOwnedModel(context, disposition.request.payload),
              )
            : yield* context.pull(
                assertJson({
                  kind: "elicit",
                  key: "ephemeral_input",
                  message: disposition.request.message,
                  response: EPHEMERAL_INPUT_RESPONSE_DESCRIPTOR,
                  context: {
                    ephemeralDriver: request.driver,
                    ephemeralTool: request.tool,
                    ephemeralKey: disposition.request.key,
                    ...(request.route !== undefined ? { ephemeralRoute: request.route } : {}),
                    responseSchema: disposition.request.responseSchema,
                    ...(disposition.request.context !== undefined
                      ? { context: disposition.request.context }
                      : {}),
                  },
                  contextContract: EPHEMERAL_INPUT_CONTEXT_DESCRIPTOR,
                  ...(disposition.request.binding === undefined
                    ? {}
                    : { binding: disposition.request.binding }),
                }),
              );

        disposition = yield* context.effect(
          EPHEMERAL_TOOL_CONTINUE_EFFECT,
          {
            continuation: disposition.continuation,
            response: { kind: disposition.request.kind, value: assertJson(response) },
          },
          {
            audience,
            ...(request.route ? { route: request.route } : {}),
          },
        );
      }
    } catch (error) {
      if (error instanceof DurableProgramCancellation && disposition.type === "input_required") {
        // The interrupted pull belongs to the principal. The parked operative
        // still needs its own cancellation command to unwind and release compute.
        yield* context.effect(
          EPHEMERAL_TOOL_CONTINUE_EFFECT,
          { continuation: disposition.continuation, response: { kind: "cancel", value: null } },
          { audience, ...(request.route ? { route: request.route } : {}) },
        );
      }
      throw error;
    }

    if (disposition.type === "completed") {
      return disposition.result;
    }
    throw new CrankError(disposition.error.code, disposition.error.message, disposition.error);
  },
);

/** Frozen built-in adapter that journals start, continuation, and pull boundaries. */
export const ephemeralToolAdapter = Object.freeze(adapterTool);
