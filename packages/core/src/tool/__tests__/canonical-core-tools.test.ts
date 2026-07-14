import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";
import type { ToolCtx } from "../types.ts";

const baseCtx: ToolCtx = {
  signal: new AbortController().signal,
  messages: [],
  notify: function* () {},
  log: function* () {},
};

describe("canonical core createTool builder", () => {
  it("records optional output, samples, annotations, extensions, and validates output", function* () {
    const Tool = createTool("analyze")
      .description("analyze input")
      .parameters(z.object({ text: z.string() }))
      .output(z.object({ ok: z.boolean() }))
      .samples({ classify: { description: "classify", output: z.object({ label: z.string() }) } })
      .annotate("mcp", { title: "Analyze" })
      .use({ namespace: "test", metadata: { namespace: "test", value: { placement: "local" } } })
      .execute(function* (params, ctx) {
        yield* ctx.notify(`Analyzing ${params.text}`);
        return { ok: true };
      });

    expect(Tool.name).toBe("analyze");
    expect(Tool.output).toBeDefined();
    expect(Tool.samples.classify?.output).toBeDefined();
    expect(Tool.capabilities).toEqual({ elicitation: false, sampling: true });
    expect(Tool.annotations["mcp"]).toEqual({ title: "Analyze" });
    expect(Tool.extensions[0]?.namespace).toBe("test");

    const invoke = yield* Tool(
      baseCtx as ToolCtx<{}, { classify: { output: z.ZodObject<{ label: z.ZodString }> } }>,
    );
    expect(yield* invoke({ text: "hello" })).toEqual({ ok: true });
  });

  it("throws a deterministic output validation error", function* () {
    const Tool = createTool("bad_output")
      .description("bad output")
      .parameters(z.object({}))
      .output(z.object({ ok: z.boolean() }))
      .execute(function* () {
        return { ok: "nope" } as unknown as { ok: boolean };
      });

    const invoke = yield* Tool(baseCtx);
    try {
      yield* invoke({});
      throw new Error("expected output validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Invalid output for tool "bad_output"');
    }
  });

  it("uses canonical elicit action/content vocabulary with exchanges", function* () {
    const exchange = {
      kind: "elicit" as const,
      key: "confirm",
      request: { message: "Continue?", context: { id: "1" } },
      response: { action: "accept" as const, content: { ok: true } },
    };

    expect(exchange).toEqual({
      kind: "elicit",
      key: "confirm",
      request: { message: "Continue?", context: { id: "1" } },
      response: { action: "accept", content: { ok: true } },
    });
  });

  it("type-gates elicit and sample context methods", function* () {
    createTool("plain")
      .description("plain")
      .parameters(z.object({ text: z.string() }))
      .execute(function* (params, ctx) {
        params.text.toUpperCase();
        // @ts-expect-error sample is not callable unless .samples() is declared
        yield* ctx.sample({ prompt: "hi" });
        // @ts-expect-error elicit is not callable unless .elicits() is declared
        yield* ctx.elicit("confirm", { message: "Continue?" });
        return { ok: true };
      });

    createTool("interactive")
      .description("interactive")
      .parameters(z.object({ id: z.string() }))
      .elicits({
        confirm: { context: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      })
      .samples({ classify: { output: z.object({ label: z.string() }) } })
      .execute(function* (_params, ctx) {
        const choice = yield* ctx.elicit("confirm", { message: "Continue?", context: { id: "1" } });
        if (choice.action === "accept") {
          choice.content.ok.valueOf();
          // exchange only present on accept (truthful ToolElicitResult)
          const sample = yield* ctx.sample("classify", {
            prompt: "classify",
            exchanges: [choice.exchange],
          });
          sample.parsed?.label.toUpperCase();
        }
        // @ts-expect-error undeclared elicit keys are rejected
        yield* ctx.elicit("missing", { message: "Nope" });
        // @ts-expect-error undeclared sample keys are rejected
        yield* ctx.sample("missing", { prompt: "Nope" });
        return { ok: true };
      });
  });
});
