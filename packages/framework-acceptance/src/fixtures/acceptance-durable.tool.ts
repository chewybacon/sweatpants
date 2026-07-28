import { createDurableEffectRegistration } from "@sweatpants/session-contract";

import { z } from "zod";
import { createDurableTool, defineEffect } from "@sweatpants/core";

import { sha256 } from "@sweatpants/session-contract";

export const ACCEPTANCE_DURABLE_TOOL_NAME = "acceptance_durable_selection";
export const DURABLE_EFFECT_NAME = "acceptance.durable.options";
export const DURABLE_SAMPLE_PROMPT_MARKER = "DURABLE_SAMPLE_PROMPT_V1";
export const DURABLE_SAMPLE_RESPONSE_MARKER = "DURABLE_SAMPLE_RESPONSE_V1";
export const DURABLE_TOOL_RESULT_MARKER = "DURABLE_TOOL_RESULT_V1";
export const DURABLE_RECORDED_MARKER = "DURABLE_RECORDED_VALUE_V1";

export const loadDurableOptions = defineEffect({
  name: DURABLE_EFFECT_NAME,
  version: "1",
  input: z.object({ topic: z.string() }),
  output: z.object({ options: z.array(z.string()).length(2) }),
  retrySafety: { mode: "repeatable" },
});

export const durableOptionsProvider = Object.freeze({
  registrations: Object.freeze([
    createDurableEffectRegistration(
      loadDurableOptions,
      { mode: "repeatable" },
      function* ({ topic }) {
        if (topic === "effect-failure") {
          throw new Error("planned durable host effect failure");
        }
        return { status: "ok" as const, value: { options: [`${topic}-alpha`, `${topic}-beta`] } };
      },
    ),
  ]),
  *install() {},
});

/**
 * Canonical replay-pure crank-native acceptance fixture. It exercises a typed
 * explicit host effects, execution-owned recording, nested sampling, elicitation,
 * worker replacement, and journal replay in one authored tool.
 */
export const acceptanceDurableTool = createDurableTool(ACCEPTANCE_DURABLE_TOOL_NAME)
  .description("Deterministic durable selection fixture")
  .identity({
    version: "1.2.0",
    digest: sha256("framework-acceptance.durable-selection@1.2.0:effection-operation"),
  })
  .parameters(z.object({ topic: z.string() }))
  .output(
    z.object({
      marker: z.literal(DURABLE_TOOL_RESULT_MARKER),
      recorded: z.string(),
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
    const { options } = yield* context.effect(
      loadDurableOptions,
      { topic },
      {
        audience: "acceptance-durable-options",
      },
    );
    const recorded = yield* context.record("acceptance-recorded-value", function* () {
      return `${DURABLE_RECORDED_MARKER}:${topic}`;
    });
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
      recorded,
      selected,
      sampleText: sample.text,
    };
  });
