import type { Operation } from "effection";

import { createDurableEffectRegistration } from "./durable-apis.ts";
import { createDurableTool, defineDurableProgramManifest } from "./authoring.ts";
import {
  FOREIGN_MODEL_SAMPLE_EFFECT,
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
} from "./foreign-tool-contract.ts";
import { CrankError, type Json } from "./types.ts";
import type { DurableEffectRegistration, ForeignToolRequest } from "./durable-types.ts";

export const FOREIGN_TOOL_ADAPTER_MANIFEST = defineDurableProgramManifest<ForeignToolRequest, Json>(
  {
    programId: FOREIGN_TOOL_ADAPTER_PROGRAM.id,
    version: FOREIGN_TOOL_ADAPTER_PROGRAM.version,
    digest: FOREIGN_TOOL_ADAPTER_PROGRAM.digest,
    inputSchema: FOREIGN_TOOL_START_EFFECT.inputSchema,
    outputSchema: true,
    elicits: {
      foreign_input: {
        responseSchema: true,
        contextSchema: true,
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

const adapterTool = createDurableTool(FOREIGN_TOOL_ADAPTER_MANIFEST, function* (request, context) {
  const audience = `foreign:${request.driver}`;
  let disposition = yield* context.effect(FOREIGN_TOOL_START_EFFECT, request, {
    audience,
    ...(request.route ? { route: request.route } : {}),
  });

  while (disposition.type === "input_required") {
    const response =
      disposition.request.kind === "sample"
        ? yield* context.effect(FOREIGN_MODEL_SAMPLE_EFFECT, disposition.request.payload, {
            audience: "model-runtime",
          })
        : yield* context.elicit<Json>("foreign_input", disposition.request.message, true, {
            foreignDriver: request.driver,
            foreignTool: request.tool,
            foreignKey: disposition.request.key,
            responseSchema: disposition.request.responseSchema,
            ...(disposition.request.context !== undefined
              ? { context: disposition.request.context }
              : {}),
          });

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

  if (disposition.type === "completed") {
    return disposition.result;
  }
  throw new CrankError(disposition.error.code, disposition.error.message, disposition.error);
});

export type ForeignToolAdapter = typeof adapterTool & {
  modelSampleRegistration(handler: (request: Json) => Operation<Json>): DurableEffectRegistration;
};

export const foreignToolAdapter: ForeignToolAdapter = Object.freeze({
  ...adapterTool,
  modelSampleRegistration(handler: (request: Json) => Operation<Json>) {
    return createDurableEffectRegistration(
      FOREIGN_MODEL_SAMPLE_EFFECT,
      { mode: "idempotent", mechanism: "pull_id_key" },
      handler,
    );
  },
});
