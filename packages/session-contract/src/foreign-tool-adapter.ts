import type { Operation } from "effection";

import { createDurableEffectRegistration } from "./durable-apis.ts";
import { createPinnedDurableProgram, defineDurableProgramManifest } from "./authoring.ts";
import {
  FOREIGN_INPUT_CONTEXT_DESCRIPTOR,
  FOREIGN_INPUT_RESPONSE_DESCRIPTOR,
  FOREIGN_MODEL_SAMPLE_EFFECT,
  FOREIGN_TOOL_ADAPTER_INPUT_DESCRIPTOR,
  FOREIGN_TOOL_ADAPTER_OUTPUT_DESCRIPTOR,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
} from "./foreign-tool-contract.ts";
import type { ModelSampleRequest, ModelSampleResult } from "./model-sample-contract.ts";
import { CrankError, type Json } from "./types.ts";
import type { DurableEffectRegistration, ForeignToolRequest } from "./durable-types.ts";

/** Validated manifest for the built-in foreign compatibility child program. */
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
      [FOREIGN_MODEL_SAMPLE_EFFECT.name]: FOREIGN_MODEL_SAMPLE_EFFECT,
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
            ? yield* context.effect(FOREIGN_MODEL_SAMPLE_EFFECT, disposition.request.payload, {
                audience: "model-runtime",
              })
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
                  ...(disposition.request.context !== undefined
                    ? { context: disposition.request.context }
                    : {}),
                },
              );

        disposition = yield* context.effect(
          FOREIGN_TOOL_CONTINUE_EFFECT,
          {
            continuation: disposition.continuation,
            response: { kind: disposition.request.kind, value: response },
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
      FOREIGN_MODEL_SAMPLE_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (request) {
        return { status: "ok", value: yield* handler(request) };
      },
    );
  },
});
