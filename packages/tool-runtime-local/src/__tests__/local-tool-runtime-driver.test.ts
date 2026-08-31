import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { describe, expect, it } from "vitest";
import { action, createQueue, run, spawn } from "effection";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { ToolRuntimeApi, createToolInventory } from "@sweatpants/tool-runtime";
import { ProgramDriverEphemeralEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import {
  createLocalToolInvocationRuntime,
  createLocalToolRuntimeDriver,
  installLocalToolRuntimeComposition,
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
  it("aborts active computation when the caller signal is cancelled", async () => {
    const started = createQueue<void, void>();
    const stopped = createQueue<void, void>();
    const activeTool = createTool("active_abort")
      .description("Active abort fixture")
      .parameters(z.object({}))
      .execute(function* () {
        started.add();
        yield* action<void>(() => () => stopped.add());
        return { unreachable: true };
      });

    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [activeTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });
      const controller = new AbortController();
      const execution = yield* spawn(function* () {
        try {
          yield* driver.execute({
            entry: createToolInventoryEntry(activeTool),
            call: {
              id: "active-abort-call",
              name: activeTool.name,
              input: {},
              thoughtSignature: null,
            },
            signal: controller.signal,
          });
          return null;
        } catch (error) {
          return error;
        }
      });

      yield* started.next();
      controller.abort();
      yield* stopped.next();
      const error = yield* execution;
      expect(error).toMatchObject({ code: "TOOL_ABORTED" });
    });
  });

  it("fails closed when no invocation runtime is installed in scope", async () => {
    await expect(
      run(function* () {
        const driver = yield* createLocalToolRuntimeDriver({
          tools: [echoTool],
          samplingProvider: {
            *sample() {
              return { text: "unused" };
            },
          },
        });
        yield* driver.execute({
          entry: createToolInventoryEntry(echoTool),
          call: {
            id: "call-no-host",
            name: "echo",
            input: { message: "hello" },
            thoughtSignature: null,
          },
        });
      }),
    ).rejects.toMatchObject({ code: "tool_invocation_host_unavailable" });
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
        });
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TOOL_STRATEGY" });
  });

  it("executes a local tool via the canonical runtime surface", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
      });

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
          name: "echo",
          input: { message: "hello" },
          thoughtSignature: null,
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
      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
      });

      const driver = yield* createLocalToolRuntimeDriver({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
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
            name: "echo",
            input: { message: "hello" },
            thoughtSignature: null,
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

      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
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
            name: "strict_echo",
            input: { wrong: "field" },
            thoughtSignature: null,
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

  it("program installer publishes matching durable ephemeral effects", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
      });

      yield* installLocalToolRuntimeComposition({
        tools: [echoTool],
        installEphemeralEffects: function* (registrations) {
          yield* ProgramDriverEphemeralEffectsContext.set(registrations);
        },
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const effects = yield* ProgramDriverEphemeralEffectsContext.get();
      expect(effects?.map((registration) => registration.definition.name)).toEqual([
        "ephemeral.tool.start",
        "ephemeral.tool.continue",
      ]);
    });
  });

  it("installer makes the runtime resolvable through the tool runtime port", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: localRuntimeWorkerConfig,
      });

      yield* installLocalToolRuntime({
        tools: [echoTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      const result = yield* ToolRuntimeApi.operations.execute({
        entry: createToolInventoryEntry(echoTool),
        call: {
          id: "call-installed",
          name: "echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
    });
  });
});
