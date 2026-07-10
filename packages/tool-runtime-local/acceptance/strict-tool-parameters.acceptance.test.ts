import { run } from "effection";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { createLocalToolRuntimeDriver, createToolInventoryEntry } from "../src/index.ts";

const workerFixtureCandidates = [
  resolve(process.cwd(), "src/__tests__/fixtures/tool-worker-bootstrap.mjs"),
  resolve(
    process.cwd(),
    "packages/tool-runtime-local/src/__tests__/fixtures/tool-worker-bootstrap.mjs",
  ),
];

const workerFixturePath = (() => {
  const candidate = workerFixtureCandidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error("Failed to resolve tool-worker-bootstrap.mjs fixture path");
  }
  return candidate;
})();

const localRuntimeWorkerConfig = {
  workerUrl: pathToFileURL(workerFixturePath),
  isDev: false,
} as const;

const strictTool = createTool("strict_echo")
  .description("Strict echo")
  .parameters(z.object({ message: z.string() }))

  .execute(function* (params) {
    return { echoed: params.message };
  });

describe("@sweatpants/tool-runtime-local strict parameter acceptance", () => {
  it("rejects invalid session params before local session or tool execution and executes valid params", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [strictTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: localRuntimeWorkerConfig },
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
      const result = yield* driver.execute({
        entry: createToolInventoryEntry(strictTool),
        call: {
          id: "call-valid-mcp",
          type: "function",
          function: { name: "strict_echo", arguments: { message: "hello" } },
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
