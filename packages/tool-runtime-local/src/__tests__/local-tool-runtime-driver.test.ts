import { describe, expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { ToolRuntimeApi, createToolInventory } from "@sweatpants/framework/chat";
import {
  createLocalToolRuntimeDriver,
  createToolInventoryEntry,
  installLocalToolRuntime,
} from "../index.ts";

const echoTool = createTool("echo")
  .description("Echo input")
  .parameters(z.object({ message: z.string() }))

  .execute(function* (params) {
    return { echoed: params.message };
  });

describe("local ToolRuntimeDriver", () => {
  it("executes a local tool via the canonical runtime surface", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(echoTool),
        call: {
          id: "call-echo",
          type: "function",
          function: { name: "echo", arguments: { message: "hello" } },
        },
      });

      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
      expect(result.ref).toMatchObject({
        runtimeId: "local",
        callId: "call-echo",
        toolName: "echo",
      });
    });
  });

  it("rejects invalid session params before creating a local session", async () => {
    await run(function* () {
      let executeCalls = 0;
      const strictTool = createTool("strict_echo")
        .description("Strict echo input")
        .parameters(z.object({ message: z.string() }))

        .execute(function* (params) {
          executeCalls++;
          return { echoed: params.message };
        });

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
            id: "call-invalid-session",
            type: "function",
            function: { name: "strict_echo", arguments: {} },
          },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: {
            toolName: "strict_echo",
            callId: "call-invalid-session",
          },
        });
      }

      expect(executeCalls).toBe(0);
    });
  });

  it("creates inventory entries with model-safe definitions and hidden implementation payloads", () => {
    const entry = createToolInventoryEntry(echoTool, { runtime: "local" });
    expect(entry.definition).toMatchObject({ name: "echo", description: "Echo input" });
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect("implementation" in entry.definition).toBe(false);
    expect(entry.implementation).toBeDefined();
    expect(entry.capabilities).toMatchObject({
      session: true,
      worker: true,
      elicits: false,
      samples: false,
    });

    expect(() => createToolInventory([entry, entry])).toThrow("Duplicate tool name");
  });

  it("installer sets ToolRuntimeContext for ToolRuntimeApi", async () => {
    await run(function* () {
      yield* installLocalToolRuntime({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const result = yield* ToolRuntimeApi.execute({
        entry: createToolInventoryEntry(echoTool),
        call: {
          id: "call-installed",
          type: "function",
          function: { name: "echo", arguments: { message: "hello" } },
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
    });
  });
});
