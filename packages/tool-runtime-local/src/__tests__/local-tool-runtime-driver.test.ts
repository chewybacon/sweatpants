import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { ToolRuntimeApi } from "@sweatpants/tool-runtime";
import { createToolInventory } from "@sweatpants/tool-runtime";
import { ProgramDriverForeignEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import {
  createInMemoryToolSessionStore,
  createLocalToolRuntimeDriver,
  createToolSessionRegistry,
  installLocalProgramToolRuntime,
  installLocalToolRuntime,
} from "../index.ts";

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

const echoTool = createTool("echo")
  .description("Echo input")
  .parameters(z.object({ message: z.string() }))

  .execute(function* (params) {
    return { echoed: params.message };
  });

describe("local ToolRuntimeDriver", () => {
  it("requires worker-backed execution", async () => {
    await expect(
      run(function* () {
        yield* createLocalToolRuntimeDriver({
          tools: [echoTool],
          samplingProvider: {
            *sample() {
              return { text: "unused" };
            },
          },
        });
      }),
    ).rejects.toMatchObject({ code: "WORKER_BACKED_LOCAL_RUNTIME_REQUIRED" });
  });

  it("rejects duplicate configured tool names deterministically", async () => {
    await expect(
      run(function* () {
        yield* createLocalToolRuntimeDriver({
          tools: [echoTool, echoTool],
          samplingProvider: {
            *sample() {
              return { text: "unused" };
            },
          },
          registryOptions: { worker: localRuntimeWorkerConfig },
        });
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TOOL_STRATEGY" });
  });

  it("executes a local tool via the canonical runtime surface", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: localRuntimeWorkerConfig },
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

  it("refuses mismatched inventory entries and call targets", async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: localRuntimeWorkerConfig },
      });

      try {
        yield* driver.execute({
          entry: {
            definition: {
              name: "other",
              description: "Other tool",
              parameters: { type: "object" },
            },
          },
          call: {
            id: "call-mismatch",
            type: "function",
            function: { name: "echo", arguments: { message: "hello" } },
          },
        });
        throw new Error("expected strategy mismatch");
      } catch (error) {
        expect(error).toMatchObject({ code: "NO_MATCHING_TOOL_STRATEGY" });
      }
    });
  });

  it("rejects invalid session params before creating a local session", async () => {
    await run(function* () {
      const strictTool = createTool("strict_echo")
        .description("Strict echo input")
        .parameters(z.object({ message: z.string() }))

        .execute(function* (params) {
          return { echoed: params.message };
        });

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
    });
  });

  it("creates runtime-neutral inventory entries with model-safe definitions", () => {
    const entry = createToolInventoryEntry(echoTool, { runtime: "local" });
    expect(entry.definition).toMatchObject({ name: "echo", description: "Echo input" });
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(entry.capabilities).toMatchObject({
      elicits: false,
      samples: false,
    });

    expect(() => createToolInventory([entry, entry])).toThrow("Duplicate tool name");
  });

  it("program installer publishes matching durable foreign effects", async () => {
    await run(function* () {
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        worker: localRuntimeWorkerConfig,
      });

      yield* installLocalProgramToolRuntime({
        tools: [echoTool],
        registry,
        installForeignEffects: function* (registrations) {
          yield* ProgramDriverForeignEffectsContext.set(registrations);
        },
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const effects = yield* ProgramDriverForeignEffectsContext.get();
      expect(effects?.map((registration) => registration.definition.name)).toEqual([
        "foreign.tool.start",
        "foreign.tool.continue",
      ]);
    });
  });

  it("installer makes the runtime resolvable through the tool runtime port", async () => {
    await run(function* () {
      yield* installLocalToolRuntime({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        registryOptions: { worker: localRuntimeWorkerConfig },
      });

      const result = yield* ToolRuntimeApi.operations.execute({
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
