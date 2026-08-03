import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDurableTool, createTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { makePlugin } from "../plugin.ts";

const ordinary = createTool("ordinary_plugin")
  .description("ordinary")
  .parameters(z.object({}))
  .elicits({ confirm: z.object({ accepted: z.boolean() }) })
  .execute(function* () {
    return "done";
  });

const transformed = createTool("transformed_plugin")
  .description("transformed")
  .parameters(z.object({}))
  .elicits({
    choose: {
      response: z.object({ value: z.string() }),
      context: z
        .object({ raw: z.string() })
        .transform(({ raw }) => ({ normalized: raw.toUpperCase() })),
    },
  })
  .execute(function* () {
    return "done";
  });

const durable = createDurableTool("durable_plugin")
  .description("durable")
  .identity({ version: "1", digest: sha256("durable-plugin@1") })
  .parameters(z.object({}))
  .elicits({ choose: z.object({ id: z.string() }) })
  .effects({})
  .execute(function* (_input, context) {
    const result = yield* context.elicit("choose", { message: "Choose" });
    return result.action === "accept" ? result.content.id : "none";
  });

describe("client makePlugin contract typing", () => {
  it("accepts ordinary and durable contracts without server registration", () => {
    const ordinaryPlugin = makePlugin(ordinary)
      .onElicit({
        confirm: function* (input, _capabilities, metadata) {
          input.context satisfies undefined;
          metadata.id.key satisfies "confirm";
          return { action: "accept" as const, content: { accepted: true } };
        },
      })
      .build();
    const transformedPlugin = makePlugin(transformed)
      .onElicit({
        choose: function* (input) {
          input.context.normalized satisfies string;
          return { action: "accept" as const, content: { value: input.context.normalized } };
        },
      })
      .build();
    const durablePlugin = makePlugin(durable)
      .onElicit({
        choose: function* (input) {
          input.context satisfies undefined;
          return { action: "accept" as const, content: { id: "chosen" } };
        },
      })
      .build();
    const genericPlugin = makePlugin<
      typeof ordinary,
      { readonly render: (value: string) => string }
    >(ordinary)
      .onElicit({
        confirm: function* (input, capabilities) {
          input.context satisfies undefined;
          capabilities.render(input.message) satisfies string;
          return { action: "decline" as const };
        },
      })
      .build();
    expect(ordinaryPlugin.client.toolName).toBe("ordinary_plugin");
    expect(transformedPlugin.client.toolName).toBe("transformed_plugin");
    expect(durablePlugin.client.toolName).toBe("durable_plugin");
    expect(genericPlugin.client.toolName).toBe("ordinary_plugin");
    expect("server" in ordinaryPlugin).toBe(false);
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
