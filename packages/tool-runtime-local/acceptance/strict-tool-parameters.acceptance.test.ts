import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { createLocalToolRuntimeDriver, createToolInventoryEntry } from "../src/index.ts";

let mcpExecuteCalls = 0;

const strictTool = createTool("strict_echo")
  .description("Strict echo")
  .parameters(z.object({ message: z.string() }))

  .execute(function* (params) {
    mcpExecuteCalls += 1;
    return { echoed: params.message };
  });

describe("@sweatpants/tool-runtime-local strict parameter acceptance", () => {
  it("rejects invalid session params before local session or tool execution and executes valid params", async () => {
    await run(function* () {
      mcpExecuteCalls = 0;
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [strictTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      try {
        yield* driver.execute({
          entry: createToolInventoryEntry(strictTool),
          call: {
            id: "call-invalid-mcp",
            type: "function",
            function: { name: "strict_echo", arguments: {} },
          },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: { toolName: "strict_echo", callId: "call-invalid-mcp" },
        });
      }
      expect(mcpExecuteCalls).toBe(0);

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(strictTool),
        call: {
          id: "call-valid-mcp",
          type: "function",
          function: { name: "strict_echo", arguments: { message: "hello" } },
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
      expect(mcpExecuteCalls).toBe(1);
    });
  });

  it("projects inventory schemas without leaking runtime schema objects", () => {
    const entry = createToolInventoryEntry(strictTool);
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone(entry.definition)).not.toThrow();
  });
});
