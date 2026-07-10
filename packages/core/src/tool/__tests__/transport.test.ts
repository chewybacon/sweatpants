import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";
import type { ToolCtx } from "../types.ts";

const baseCtx: ToolCtx = {
  messages: [],
  notify: function* () {},
  log: function* () {},
};

describe("builder validation behavior", () => {
  it("fails deterministically for invalid input", function* () {
    const Tool = createTool("strict_input")
      .description("Strict input")
      .parameters(z.object({ count: z.number() }))
      .execute(function* ({ count }) {
        return { doubled: count * 2 };
      });

    const invoke = yield* Tool(baseCtx);

    try {
      yield* invoke({ count: "nope" } as unknown as { count: number });
      throw new Error("expected invalid input failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: string }).code).toBe("invalid_tool_input");
      expect((error as Error).message).toContain('Invalid input for tool "strict_input"');
    }
  });

  it("fails deterministically for invalid output", function* () {
    const Tool = createTool("strict_output")
      .description("Strict output")
      .parameters(z.object({}))
      .output(z.object({ ok: z.boolean() }))
      .execute(function* () {
        return { ok: "nope" } as unknown as { ok: boolean };
      });

    const invoke = yield* Tool(baseCtx);

    try {
      yield* invoke({});
      throw new Error("expected invalid output failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: string }).code).toBe("invalid_tool_output");
      expect((error as Error).message).toContain('Invalid output for tool "strict_output"');
    }
  });
});
