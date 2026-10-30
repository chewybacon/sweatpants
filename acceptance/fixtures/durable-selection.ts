import { defineEffect } from "@sweatpants/agent-sdk";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { z } from "zod";

export const loadOptions = defineEffect({
  name: "selection.options",
  version: "1",
  input: z.object({ topic: z.string() }),
  output: z.object({ options: z.array(z.string()).length(2) }),
  retrySafety: { mode: "repeatable" },
});

export function selectionEffects(onExecute: (topic: string) => void = () => {}) {
  return [
    createDurableEffectRegistration(loadOptions, { mode: "repeatable" }, function* ({ topic }) {
      onExecute(topic);
      if (topic === "effect-failure") {
        throw new Error("Planned options effect failure");
      }
      return { status: "ok" as const, value: { options: [`${topic}-alpha`, `${topic}-beta`] } };
    }),
  ];
}

export const durableSelection = createDurableTool("select_option")
  .description("Load options once, record a value, sample privately and ask for a choice")
  .identity({ version: "1", digest: "d".repeat(64) })
  .parameters(z.object({ topic: z.string() }))
  .output(z.object({ selected: z.string(), recorded: z.string(), sampleText: z.string() }))
  .elicits({
    choose: {
      response: z.object({ selected: z.string() }),
      context: z.object({ options: z.array(z.string()).length(2) }),
    },
  })
  .effects({ [loadOptions.name]: loadOptions })
  .samples()
  .execute(function* ({ topic }, ctx) {
    const { options } = yield* ctx.effect(
      loadOptions,
      { topic },
      { audience: "selection-options" },
    );
    const recorded = yield* ctx.record({ key: "selection-record" }, function* () {
      return `${topic}-recorded`;
    });
    const sample = yield* ctx.sample({ prompt: `PRIVATE_SELECTION_NOTE ${topic}` });
    const response = yield* ctx.elicit("choose", {
      message: "Choose an option",
      context: { options },
    });
    return {
      selected:
        response.action === "accept" && options.includes(response.content.selected)
          ? response.content.selected
          : "none",
      recorded,
      sampleText: sample.text,
    };
  });
