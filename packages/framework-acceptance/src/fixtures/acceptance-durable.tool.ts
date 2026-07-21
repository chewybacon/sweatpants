import { z } from "zod";
import { createDurableTool, defineEffect, effectRuntimeValidators } from "@sweatpants/core";
import {
  createDurableEffectRegistration,
  sha256,
  type DurableEffectRegistration,
} from "@sweatpants/session-contract";

export const ACCEPTANCE_DURABLE_TOOL_NAME = "acceptance_durable_selection";
export const DURABLE_EFFECT_NAME = "acceptance.durable.options";
export const DURABLE_SAMPLE_PROMPT_MARKER = "DURABLE_SAMPLE_PROMPT_V1";
export const DURABLE_SAMPLE_RESPONSE_MARKER = "DURABLE_SAMPLE_RESPONSE_V1";
export const DURABLE_TOOL_RESULT_MARKER = "DURABLE_TOOL_RESULT_V1";

export const loadDurableOptions = defineEffect({
  name: DURABLE_EFFECT_NAME,
  version: "1",
  input: z.object({ topic: z.string() }),
  output: z.object({ options: z.array(z.string()).length(2) }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

/**
 * Canonical replay-pure crank-native acceptance fixture. Worker replacement is
 * observed by the host ProgramDriver wrapper, never embedded in durable data.
 */
export const acceptanceDurableTool = createDurableTool(ACCEPTANCE_DURABLE_TOOL_NAME)
  .description("Deterministic durable selection fixture")
  .identity({
    version: "1.0.0",
    digest: sha256("framework-acceptance.durable-selection@1.0.0"),
  })
  .parameters(z.object({ topic: z.string() }))
  .output(
    z.object({
      marker: z.literal(DURABLE_TOOL_RESULT_MARKER),
      selected: z.string(),
      sampleText: z.string(),
    }),
  )
  .elicits({
    chooseOption: {
      response: z.object({ selected: z.string() }),
      context: z.object({ options: z.array(z.string()).length(2) }),
    },
  })
  .effects({ [loadDurableOptions.name]: loadDurableOptions })
  .samples()
  .execute(function* ({ topic }, context) {
    const { options } = yield* context.effect(loadDurableOptions, { topic });
    const sample = yield* context.sample({
      prompt: `${DURABLE_SAMPLE_PROMPT_MARKER} Give one short note about ${topic}`,
    });
    const response = yield* context.elicit("chooseOption", {
      message: `Choose one durable option for ${topic}`,
      context: { options },
    });
    const selected =
      response.action === "accept" && options.includes(response.content.selected)
        ? response.content.selected
        : "none";
    return {
      marker: DURABLE_TOOL_RESULT_MARKER,
      selected,
      sampleText: sample.text,
    };
  });

export function createDurableOptionsRegistration(): DurableEffectRegistration {
  return createDurableEffectRegistration(
    loadDurableOptions,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* ({ topic }) {
      if (topic === "effect-failure") {
        throw new Error("planned durable host effect failure");
      }
      return {
        status: "ok",
        value: { options: [`${topic}-alpha`, `${topic}-beta`] },
      };
    },
    effectRuntimeValidators(loadDurableOptions),
  );
}
