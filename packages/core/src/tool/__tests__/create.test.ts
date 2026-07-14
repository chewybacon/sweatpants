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

describe("createTool builder", () => {
  it("creates an invokable tool with validated input and output", function* () {
    const Echo = createTool("echo")
      .description("Echo input")
      .parameters(z.object({ message: z.string() }))
      .output(z.object({ echoed: z.string() }))
      .execute(function* ({ message }) {
        return { echoed: message };
      });

    const invoke = yield* Echo(baseCtx);
    expect(yield* invoke({ message: "hello" })).toEqual({ echoed: "hello" });
  });

  it("supports multiple invocations from one activated tool", function* () {
    let count = 0;

    const Counter = createTool("counter")
      .description("Count invocations")
      .parameters(z.object({}))
      .output(z.object({ count: z.number() }))
      .execute(function* () {
        count += 1;
        return { count };
      });

    const invoke = yield* Counter(baseCtx);
    expect(yield* invoke({})).toEqual({ count: 1 });
    expect(yield* invoke({})).toEqual({ count: 2 });
    expect(yield* invoke({})).toEqual({ count: 3 });
  });

  it("propagates implementation errors unchanged", function* () {
    const Failing = createTool("failing")
      .description("Always fails")
      .parameters(z.object({}))
      .execute(function* () {
        throw new Error("Intentional failure");
      });

    const invoke = yield* Failing(baseCtx);

    try {
      yield* invoke({});
      throw new Error("expected tool failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Intentional failure");
    }
  });

  it("exposes normalized elicitation and sampling capabilities", function* () {
    const Tool = createTool("interactive")
      .description("Interactive tool")
      .parameters(z.object({ id: z.string() }))
      .elicits({ confirm: { response: z.object({ ok: z.boolean() }) } })
      .samples({ classify: { output: z.object({ label: z.string() }) } })
      .execute(function* () {
        return { ok: true };
      });

    expect(Tool.elicits.confirm?.response).toBeDefined();
    expect(Tool.samples.classify?.output).toBeDefined();
    expect(Tool.capabilities).toEqual({ elicitation: true, sampling: true });
  });
});
