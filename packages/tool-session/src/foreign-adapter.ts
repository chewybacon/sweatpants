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
  FOREIGN_INPUT_CONTEXT_DESCRIPTOR,
  FOREIGN_INPUT_RESPONSE_DESCRIPTOR,
  FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR,
  FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
} from "./foreign-contract.ts";
import { projectModelSampleCompletion } from "@sweatpants/agent-sdk";
import { CrankError, type DurableProgramContext } from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { ForeignToolRequest } from "@sweatpants/durable-execution";

/**
 * Classification stamped onto every model.sample raised on behalf of a
 * foreign tool's nested ctx.sample(). Hosts use it to keep tool-owned
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
      "Foreign adapter model sampling requires an authoring-edge context stager",
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

/** Validated manifest for the built-in foreign adapter child program. */
export const FOREIGN_TOOL_ADAPTER_MANIFEST = defineDurableProgramManifest<ForeignToolRequest, Json>(
  {
    programId: FOREIGN_TOOL_ADAPTER_PROGRAM.id,
    version: FOREIGN_TOOL_ADAPTER_PROGRAM.version,
    digest: FOREIGN_TOOL_ADAPTER_PROGRAM.digest,
    inputSchema: FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR,
    outputSchema: FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR,
    elicits: {
      foreign_input: {
        response: FOREIGN_INPUT_RESPONSE_DESCRIPTOR,
        context: FOREIGN_INPUT_CONTEXT_DESCRIPTOR,
      },
    },
    effects: {
      [FOREIGN_TOOL_START_EFFECT.name]: FOREIGN_TOOL_START_EFFECT,
      [FOREIGN_TOOL_CONTINUE_EFFECT.name]: FOREIGN_TOOL_CONTINUE_EFFECT,
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
  },
);

const adapterTool = createPinnedDurableProgram(
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  function* (request, context) {
    const audience = `foreign:${request.driver}`;
    let disposition = yield* context.effect(FOREIGN_TOOL_START_EFFECT, request, {
      audience,
      ...(request.route ? { route: request.route } : {}),
    });

    while (disposition.type === "input_required") {
      const response =
        disposition.request.kind === "sample"
          ? projectModelSampleCompletion(
              yield* sampleToolOwnedModel(context, disposition.request.payload),
            )
          : yield* context.pull(
              assertJson({
                kind: "elicit",
                key: "foreign_input",
                message: disposition.request.message,
                response: FOREIGN_INPUT_RESPONSE_DESCRIPTOR,
                context: {
                  foreignDriver: request.driver,
                  foreignTool: request.tool,
                  foreignKey: disposition.request.key,
                  ...(request.route !== undefined ? { foreignRoute: request.route } : {}),
                  responseSchema: disposition.request.responseSchema,
                  ...(disposition.request.context !== undefined
                    ? { context: disposition.request.context }
                    : {}),
                },
                contextContract: FOREIGN_INPUT_CONTEXT_DESCRIPTOR,
                ...(disposition.request.binding === undefined
                  ? {}
                  : { binding: disposition.request.binding }),
              }),
            );

      disposition = yield* context.effect(
        FOREIGN_TOOL_CONTINUE_EFFECT,
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

    if (disposition.type === "completed") {
      return disposition.result;
    }
    throw new CrankError(disposition.error.code, disposition.error.message, disposition.error);
  },
);

/** Frozen built-in adapter that journals start, continuation, and pull boundaries. */
export const foreignToolAdapter = Object.freeze(adapterTool);
