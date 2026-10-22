import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { run } from "effection";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocalToolInvocationRuntime } from "@sweatpants/tool-runtime-local";
import { createInvocationToolRuntimeDriver } from "@sweatpants/tool-session/execution";

const workerFixturePath = resolve("__tests__/tool-runtimes/local-worker/fixtures/tool-worker.mjs");

const localRuntimeWorkerConfig = {
  workerUrl: pathToFileURL(workerFixturePath),
  isDev: false,
} as const;

import { strictEcho as strictTool } from "../../../fixtures/echo-tool.ts";

describe("@sweatpants/tool-runtime-local strict parameter acceptance", () => {
  it("rejects invalid session params before local session or tool execution and executes valid params", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
      });

      const driver = yield* createInvocationToolRuntimeDriver({
        id: "local",
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
          call: { id: "call-invalid-mcp", name: "strict_echo", input: {}, thoughtSignature: null },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: { toolName: "strict_echo", callId: "call-invalid-mcp" },
        });
      }
      const result = yield* driver.execute({
        entry: createToolInventoryEntry(strictTool),
        call: {
          id: "call-valid-mcp",
          name: "strict_echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
    });
  });

  it("projects inventory schemas without leaking runtime schema objects", () => {
    const entry = createToolInventoryEntry(strictTool);
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone(entry.definition)).not.toThrow();
  });
});
