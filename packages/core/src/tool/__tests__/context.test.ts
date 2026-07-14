import { describe, expect, it } from "@effectionx/vitest";
import { z } from "zod";
import { createTool } from "../create.ts";
import type { ToolCtx } from "../types.ts";

describe("ToolCtx integration", () => {
  it("lets tools use notify, log, and messages from the provided context", function* () {
    const notifications: Array<{ message: string; progress?: number }> = [];
    const logs: Array<{ level: string; message: string }> = [];

    const ctx: ToolCtx = {
      signal: new AbortController().signal,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      notify: function* (message, progress) {
        notifications.push({ message, progress });
      },
      log: function* (level, message) {
        logs.push({ level, message });
      },
    };

    const Tool = createTool("contextful")
      .description("Uses ToolCtx services")
      .parameters(z.object({ value: z.string() }))
      .execute(function* ({ value }, innerCtx) {
        yield* innerCtx.notify(`working ${value}`, 0.5);
        yield* innerCtx.log("info", `logged ${value}`);
        return {
          result: value.toUpperCase(),
          observedMessages: innerCtx.messages.length,
        };
      });

    const invoke = yield* Tool(ctx);
    expect(yield* invoke({ value: "hello" })).toEqual({
      result: "HELLO",
      observedMessages: 1,
    });
    expect(notifications).toEqual([{ message: "working hello", progress: 0.5 }]);
    expect(logs).toEqual([{ level: "info", message: "logged hello" }]);
  });
});
