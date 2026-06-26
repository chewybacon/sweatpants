import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";

describe("createTool(name) unified builder", () => {
  it("requires .elicits() before .execute() and preserves normalized metadata", function* () {
    expect(() =>
      // @ts-expect-error runtime guard for migration/non-TS callers
      createTool("bad").description("bad").parameters(z.object({})).execute(function* () {
        return {};
      }),
    ).toThrow(/\.elicits\(\)/);

    const Tool = createTool("confirm")
      .description("confirm something")
      .parameters(z.object({ id: z.string() }))
      .elicits({ confirm: z.object({ ok: z.boolean() }) })
      .requires({ elicitation: true })
      .execute(function* (input) {
        return { id: input.id, done: true };
      });

    expect(Tool.name).toBe("confirm");
    expect(Tool.capabilities.elicitation).toBe(true);
    expect(Tool.elicits["confirm"]?.mode).toBe("form");
    expect(Tool.elicits["confirm"]?.response).toBeDefined();
  });

  it("activates as a unified callable against a ToolCtx", function* () {
    const Tool = createTool("echo")
      .description("echo")
      .parameters(z.object({ text: z.string() }))
      .elicits({})
      .execute(function* (input, ctx) {
        ctx.history.push({ seen: input.text });
        return { echoed: input.text };
      });

    const history: unknown[] = [];
    const invoke = yield* Tool({
      history,
      elicit: (() => { throw new Error("not used"); }) as never,
      elicitDynamic: (() => { throw new Error("not used"); }) as never,
      sample: (() => { throw new Error("not used"); }) as never,
      notify: function* () {},
      log: function* () {},
    });

    expect(yield* invoke({ text: "hi" })).toEqual({ echoed: "hi" });
    expect(history).toEqual([{ seen: "hi" }]);
  });
});
