import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";

describe("createTool(name) unified builder", () => {
  it("allows optional .elicits() before .execute() and preserves normalized metadata", function* () {
    const Minimal = createTool("minimal")
      .description("minimal")
      .parameters(z.object({}))
      .execute(function* () {
        return {};
      });

    expect(Minimal.capabilities.elicitation).toBe(false);

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
    expect(Tool.elicits["confirm"]?.response).toBeDefined();
  });

  it("rejects invalid params before invoking a unified tool implementation", function* () {
    let calls = 0;
    const Tool = createTool("book_flight")
      .description("book a flight")
      .parameters(z.object({ from: z.string(), destination: z.string() }))
      .elicits({})
      .execute(function* (input) {
        calls++;
        return { route: `${input.from}-${input.destination}` };
      });

    const invoke = yield* Tool({
      signal: new AbortController().signal,
      messages: [],
      notify: function* () {},
      log: function* () {},
    });

    try {
      yield* invoke({ destination: "NYC" } as unknown as { from: string; destination: string });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Invalid input for tool");
    }

    expect(calls).toBe(0);
    expect(yield* invoke({ from: "Boston", destination: "NYC" })).toEqual({ route: "Boston-NYC" });
    expect(calls).toBe(1);
  });

  it("activates as a unified callable against a ToolCtx", function* () {
    const seen: unknown[] = [];
    const Tool = createTool("echo")
      .description("echo")
      .parameters(z.object({ text: z.string() }))
      .elicits({})
      .execute(function* (input) {
        seen.push({ seen: input.text });
        return { echoed: input.text };
      });

    const invoke = yield* Tool({
      signal: new AbortController().signal,
      messages: [],
      notify: function* () {},
      log: function* () {},
    });

    expect(yield* invoke({ text: "hi" })).toEqual({ echoed: "hi" });
    expect(seen).toEqual([{ seen: "hi" }]);
  });
});
