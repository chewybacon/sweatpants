import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { run } from "effection";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createLocalToolInvocationRuntime } from "../src/index.ts";
import { createInvocationToolRuntimeDriver } from "@sweatpants/tool-session/execution";

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
