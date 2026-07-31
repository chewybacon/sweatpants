import {
  ToolInventoryApi,
  ToolInventoryContext,
  ToolInventoryError,
  createToolInventory,
  createToolInventoryEntry,
  type ToolInventoryEntry,
} from "@sweatpants/tool-runtime";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import {
  ToolExposureApi,
  ToolExposureError,
  ToolExposurePolicyContext,
  defaultToolExposurePolicy,
} from "@sweatpants/chat-core";
import {
  ToolRuntimeApi,
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  installToolRuntime,
  type ToolExecutionStrategy,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";

const echoEntry: ToolInventoryEntry = {
  definition: {
    name: "echo",
    description: "Echo input",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
  capabilities: { inline: true },
};

const clientEntry: ToolInventoryEntry = {
  definition: {
    name: "pick_color",
    description: "Pick a color in the browser",
    parameters: { type: "object", properties: {}, required: [] },
  },
  capabilities: { client: true },
};

const call = {
  id: "call-1",
  type: "function" as const,
  function: { name: "echo", arguments: { input: "hello" } },
};

describe("tool inventory runtime completion contracts", () => {
  it("creates inventory in insertion order and resolves only canonical names", async () => {
    await run(function* () {
      const inventory = createToolInventory([echoEntry, clientEntry]);
      expect((yield* inventory.list()).map((entry) => entry.definition.name)).toEqual([
        "echo",
        "pick_color",
      ]);
      expect((yield* inventory.resolve("echo"))?.definition.name).toBe("echo");
      expect(yield* inventory.resolve("namespace_echo")).toBeNull();
    });
  });

  it("rejects duplicate canonical tool names deterministically", () => {
    expect(() => createToolInventory([echoEntry, echoEntry])).toThrow(ToolInventoryError);
    expect(() => createToolInventory([echoEntry, echoEntry])).toThrow("Duplicate tool name");
  });

  it("ToolInventoryApi handles installed, missing-tool, and missing-inventory cases", async () => {
    await run(function* () {
      yield* ToolInventoryContext.set(createToolInventory([echoEntry]));
      expect((yield* ToolInventoryApi.list()).length).toBe(1);
      expect((yield* ToolInventoryApi.resolve("echo")).definition.name).toBe("echo");
      try {
        yield* ToolInventoryApi.resolve("missing");
        throw new Error("expected missing tool to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "TOOL_NOT_FOUND" });
      }
    });

    await run(function* () {
      try {
        yield* ToolInventoryApi.list();
        throw new Error("expected missing inventory to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "TOOL_INVENTORY_NOT_CONFIGURED" });
      }
    });
  });

  it("default exposure returns model-safe definitions and supports sample-local tools", async () => {
    await run(function* () {
      const outer = yield* defaultToolExposurePolicy.filter({
        phase: "outer-chat",
        entries: [echoEntry],
        enabledTools: true,
      });
      expect(outer).toEqual([echoEntry.definition]);

      const sample = yield* defaultToolExposurePolicy.filter({
        phase: "sample",
        sampleTools: [
          { name: "choose_move", description: "Choose move", inputSchema: { type: "object" } },
        ],
      });
      expect(sample).toEqual([
        { name: "choose_move", description: "Choose move", parameters: { type: "object" } },
      ]);
    });
  });

  it("projects runtime-neutral capabilities from runtime tools", () => {
    const interactiveTool = createTool("interactive")
      .description("Interactive tool")
      .parameters(z.object({ prompt: z.string() }))
      .elicits({ confirm: { response: z.object({ ok: z.boolean() }) } })
      .samples({ classify: { output: z.object({ label: z.string() }) } })
      .execute(function* () {
        return { ok: true };
      });

    const entry = createToolInventoryEntry(interactiveTool, { scope: "test" });
    expect(entry.definition).toMatchObject({
      name: "interactive",
      description: "Interactive tool",
    });
    expect(entry.capabilities).toEqual({ elicits: true, samples: true });
    expect(entry.capabilities).not.toHaveProperty("remote");
    expect(entry.capabilities).not.toHaveProperty("session");
    expect(entry.capabilities).not.toHaveProperty("worker");
  });

  it("custom sample exposure policy can fail closed", async () => {
    await run(function* () {
      yield* ToolExposurePolicyContext.set({
        *filter() {
          throw new ToolExposureError("SAMPLE_TOOL_REJECTED", "sample tool rejected by policy");
        },
      });
      try {
        yield* ToolExposureApi.definitions({
          phase: "sample",
          sampleTools: [{ name: "dangerous" }],
        });
        throw new Error("expected sample policy rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "SAMPLE_TOOL_REJECTED" });
      }
    });
  });

  it("strategy runtime selects first matching strategy and never falls back implicitly", async () => {
    const selected: string[] = [];
    const makeStrategy = (id: string): ToolExecutionStrategy => ({
      id,
      canExecute: () => true,
      *execute(_entry, requestCall, ctx) {
        selected.push(id);
        return {
          kind: "completed",
          ref: createToolExecutionRef({
            runtimeId: ctx.runtimeId,
            callId: requestCall.id,
            toolName: requestCall.function.name,
          }),
          result: id,
        };
      },
    });

    await run(function* () {
      const runtime = createStrategyToolRuntime({
        id: "test",
        strategies: [makeStrategy("a"), makeStrategy("b")],
      });
      const result = yield* runtime.execute({ entry: echoEntry, call });
      expect(result.kind).toBe("completed");
      expect(result.kind === "completed" ? result.result : undefined).toBe("a");
      expect(selected).toEqual(["a"]);

      const noMatch = createStrategyToolRuntime({
        id: "test",
        strategies: [{ ...makeStrategy("never"), canExecute: () => false }],
      });
      try {
        yield* noMatch.execute({ entry: echoEntry, call });
        throw new Error("expected no matching strategy");
      } catch (error) {
        expect(error).toMatchObject({ code: "NO_MATCHING_TOOL_STRATEGY" });
      }
    });
  });

  it("rejects overlapping declared tool ownership across strategies", () => {
    const makeStrategy = (id: string, toolNames: string[]): ToolExecutionStrategy => ({
      id,
      toolNames,
      canExecute: () => false,
      *execute() {
        throw new Error("unreachable");
      },
    });

    expect(() =>
      createStrategyToolRuntime({
        id: "test",
        strategies: [makeStrategy("local", ["echo"]), makeStrategy("agentcore", ["echo"])],
      }),
    ).toThrow(ToolRuntimeError);
    expect(() =>
      createStrategyToolRuntime({
        id: "test",
        strategies: [makeStrategy("local", ["echo"]), makeStrategy("agentcore", ["echo"])],
      }),
    ).toThrow(/multiple execution strategies/);
  });

  it("ToolRuntimeApi delegates and rejects missing/wrong runtimes", async () => {
    const runtime: ToolRuntime = {
      *runtimeId() {
        return "local";
      },
      *execute(request) {
        return {
          kind: "completed",
          ref: createToolExecutionRef({
            runtimeId: "local",
            callId: request.call.id,
            toolName: request.call.function.name,
          }),
          result: "ok",
        };
      },
      *resume(request) {
        return { kind: "completed", ref: request.ref, result: "resumed" };
      },
      *abort() {},
    };

    await run(function* () {
      yield* installToolRuntime(runtime);
      expect((yield* ToolRuntimeApi.operations.execute({ entry: echoEntry, call })).kind).toBe(
        "completed",
      );
      try {
        yield* ToolRuntimeApi.operations.resume({
          ref: { runtimeId: "other", executionId: "exec", callId: "call-1", toolName: "echo" },
          input: { type: "elicit_response", completion: { action: "accept", content: null } },
        });
        throw new Error("expected wrong runtime");
      } catch (error) {
        expect(error).toMatchObject({ code: "WRONG_TOOL_RUNTIME" });
      }
    });

    await run(function* () {
      try {
        yield* ToolRuntimeApi.operations.execute({ entry: echoEntry, call });
        throw new Error("expected missing runtime");
      } catch (error) {
        expect(error).toMatchObject({ code: "TOOL_RUNTIME_NOT_CONFIGURED" });
      }
    });
  });
});
