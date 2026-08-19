import {
  MODEL_SAMPLE_EFFECT,
  decodeModelSampleRequest,
  decodeModelSampleSourceRequest,
  encodeModelSampleResult,
  resolveModelSampleSourceRequest,
  sampleDurableModel,
  type ModelSampleRequest,
  type ModelSampleResult,
} from "@sweatpants/model-sampling";
import type { Operation } from "effection";

import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
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
import { ModelContextSourceResolverContext } from "@sweatpants/model-sampling";
import { CrankError } from "@sweatpants/durable-execution";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { DurableEffectRegistration } from "@sweatpants/durable-effects";
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
      [MODEL_SAMPLE_EFFECT.name]: MODEL_SAMPLE_EFFECT,
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

    let terminal = false;
    try {
      while (disposition.type === "input_required") {
        const response =
          disposition.request.kind === "sample"
            ? projectModelSampleCompletion(
                yield* sampleDurableModel(
                  context,
                  classifyToolOwnedSample(disposition.request.payload),
                  { audience: "model-runtime" },
                ),
              )
            : yield* context.elicit<Json>(
                "foreign_input",
                disposition.request.message,
                FOREIGN_INPUT_RESPONSE_DESCRIPTOR,
                {
                  foreignDriver: request.driver,
                  foreignTool: request.tool,
                  foreignKey: disposition.request.key,
                  ...(request.route !== undefined ? { foreignRoute: request.route } : {}),
                  responseSchema: disposition.request.responseSchema,
                  interactionBinding: disposition.request.binding,
                  ...(disposition.request.context !== undefined
                    ? { context: disposition.request.context }
                    : {}),
                },
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

      terminal = true;
      if (disposition.type === "completed") {
        return disposition.result;
      }
      throw new CrankError(disposition.error.code, disposition.error.message, disposition.error);
    } finally {
      if (!terminal && disposition.type === "input_required") {
        yield* context.effect(
          FOREIGN_TOOL_CONTINUE_EFFECT,
          {
            continuation: disposition.continuation,
            response: { kind: "cancel", value: null },
          },
          {
            audience,
            ...(request.route ? { route: request.route } : {}),
          },
        );
      }
    }
  },
);

/** Durable adapter tool plus helper registration for lifted model sampling. */
export type ForeignToolAdapter = typeof adapterTool & {
  modelSampleRegistration(
    handler: (request: ModelSampleRequest) => Operation<ModelSampleResult>,
  ): DurableEffectRegistration;
};

/** Frozen built-in adapter that journals start, continuation, and sampling boundaries. */
export const foreignToolAdapter: ForeignToolAdapter = Object.freeze({
  ...adapterTool,
  modelSampleRegistration(handler: (request: ModelSampleRequest) => Operation<ModelSampleResult>) {
    return createDurableEffectRegistration(
      MODEL_SAMPLE_EFFECT,
      MODEL_SAMPLE_EFFECT.retrySafety,
      function* (wireRequest) {
        const sourceRequest = decodeModelSampleSourceRequest(wireRequest);
        const resolveContext = yield* ModelContextSourceResolverContext.get();
        if (!resolveContext) {
          throw new CrankError(
            "model_context_source_invalid",
            "Foreign model sampling registration has no context source resolver",
          );
        }
        const request = resolveModelSampleSourceRequest(
          sourceRequest,
          yield* resolveContext(sourceRequest.invocation.context),
        );
        const result = yield* handler(request);
        return { status: "ok", value: encodeModelSampleResult(result) };
      },
    );
  },
});
