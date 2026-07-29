import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDurableTool, createTool } from "@sweatpants/core";
import { sha256 } from "@sweatpants/foundation";

import { makePlugin } from "../plugin.ts";

const ordinary = createTool("ordinary_plugin")
  .description("ordinary")
  .parameters(z.object({}))
  .elicits({ confirm: z.object({ accepted: z.boolean() }) })
  .execute(function* () {
    return "done";
  });

const durable = createDurableTool("durable_plugin")
  .description("durable")
  .identity({ version: "1", digest: sha256("durable-plugin@1") })
  .parameters(z.object({}))
  .elicits({
    choose: z.object({ id: z.string() }),
  })
  .effects({})
  .execute(function* (_input, context) {
    const result = yield* context.elicit("choose", { message: "Choose" });
    return result.action === "accept" ? result.content.id : "none";
  });

describe("makePlugin ToolContract typing", () => {
  it("accepts ordinary and durable contracts without installing execution", () => {
    const ordinaryPlugin = makePlugin(ordinary)
      .onElicit({
        confirm: function* () {
          return { action: "accept" as const, content: { accepted: true } };
        },
      })
      .build();
    const durablePlugin = makePlugin(durable)
      .onElicit({
        choose: function* () {
          return { action: "accept" as const, content: { id: "chosen" } };
        },
      })
      .build();
    expect(ordinaryPlugin.server.execution).toBe("ordinary");
    expect(durablePlugin.server.execution).toBe("crank_native");
    expect("tools" in durablePlugin.server).toBe(false);
  });

  it("rejects missing and extra handler keys at compile time", () => {
    // @ts-expect-error confirm handler is exhaustive and required
    makePlugin(ordinary).onElicit({});
    makePlugin(ordinary).onElicit({
      confirm: function* () {
        return { action: "accept" as const, content: { accepted: true } };
      },
      // @ts-expect-error undeclared handlers are rejected
      extra: function* () {
        return { action: "cancel" as const };
      },
    });
    expect(true).toBe(true);
  });
});
