import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineDurableEffect } from "@sweatpants/session-contract";

import { createDurableTool } from "../durable-create.ts";

const echo = defineDurableEffect<string, { echoed: string }>({
  name: "echo",
  version: "1",
  inputSchema: { type: "string" },
  outputSchema: {
    type: "object",
    required: ["echoed"],
    properties: { echoed: { type: "string" } },
    additionalProperties: false,
  },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

describe("createDurableTool fluent builder", () => {
  it("lowers inferred output to schema true and supplies a stable default effect audience", () => {
    const tool = createDurableTool("durable.echo")
      .description("Echo durably")
      .identity({ version: "1.0.0", digest: "a".repeat(64) })
      .parameters(z.object({ message: z.string() }))
      .effects({ echo })
      .execute(function* ({ message }, context) {
        return yield* context.effect(echo, message);
      });

    expect(tool.name).toBe("durable.echo");
    expect(tool.description).toBe("Echo durably");
    expect(tool.manifest.outputSchema).toBe(true);
    expect(tool.manifest.effects).toEqual({ echo });
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it("uses refined Zod output and elicit schemas in the low-level manifest", () => {
    const tool = createDurableTool("durable.refined")
      .description("Refined")
      .identity({ version: "2", digest: "b".repeat(64) })
      .parameters(z.object({ message: z.string() }))
      .output(z.object({ echoed: z.string() }))
      .elicits({ approval: z.boolean() })
      .effects({ echo })
      .execute(function* ({ message }, context) {
        return yield* context.effect(echo, message);
      });

    expect(tool.manifest.outputSchema).toMatchObject({ type: "object" });
    expect(tool.manifest.elicits.approval?.responseSchema).toMatchObject({ type: "boolean" });
  });

  it("rejects mutable or malformed identity at runtime", () => {
    expect(() =>
      createDurableTool("bad")
        .description("bad")
        .identity({ version: "latest", digest: "not-a-digest" }),
    ).toThrow(/SHA-256/);
  });
});
